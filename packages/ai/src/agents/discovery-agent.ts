import { z } from "zod";
import { DiscoveryReportSchema, type DiscoveryReport } from "@demoforge/contracts";
import type { BrowserController } from "@demoforge/browser";
import { isDemoForgeError, type Logger } from "@demoforge/shared";
import type { AIProvider, ToolSpec } from "../contracts/types";
import { loadPrompt, untrusted } from "../prompts";
import { TargetInput, toTarget } from "../tools/browser-tools";
import { runToolLoop, type ToolHandler } from "./tool-loop";
import { formatProductContext, type ProductContext } from "./context";

const Inputs = {
  navigate: z.object({ url: z.string() }),
  click: z.object({ target: TargetInput }),
  scroll: z.object({ direction: z.enum(["up", "down"]) }),
  observe_page: z.object({}),
  note: z.object({ area: z.string(), observation: z.string() }),
  finish_discovery: z.object({ summary: z.string() }),
};

const TOOLS: ToolSpec[] = [
  { name: "navigate", description: "Open a page of the app (path or allowed URL).", inputSchema: Inputs.navigate },
  { name: "click", description: "Click a navigation element: link, tab, or menu item. Data-changing clicks are blocked.", inputSchema: Inputs.click },
  { name: "scroll", description: "Scroll the page.", inputSchema: Inputs.scroll },
  { name: "observe_page", description: "Get the current page snapshot.", inputSchema: Inputs.observe_page },
  { name: "note", description: "Record an observation about an area of the app.", inputSchema: Inputs.note },
  { name: "finish_discovery", description: "End exploration with a short summary.", inputSchema: Inputs.finish_discovery },
];

export interface DiscoveryInput {
  provider: AIProvider;
  controller: BrowserController;
  product: ProductContext;
  maxPages: number;
  maxIterations: number;
  maxDurationS: number;
  log: Logger;
}

export interface DiscoveryResult {
  report: DiscoveryReport;
  visited: string[];
  notes: { area: string; observation: string }[];
}

/** Read-only exploration followed by a structured report. Never changes application data. */
export async function runDiscovery(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { controller } = input;
  const visited = new Set<string>([controller.currentUrl()]);
  const notes: { area: string; observation: string }[] = [];
  let summary = "";

  const page = async () => {
    const obs = await controller.observe(10_000);
    visited.add(obs.url);
    return `URL: ${obs.url}\nTitle: ${obs.title}\n${untrusted(obs.snapshot)}`;
  };
  const guarded = async (fn: () => Promise<unknown>) => {
    if (visited.size >= input.maxPages) return { content: "Page budget reached. Call finish_discovery.", isError: true };
    try {
      await fn();
      return { content: await page() };
    } catch (error) {
      const message = isDemoForgeError(error) ? `${error.code}: ${error.message}` : (error as Error).message;
      return { content: `${message}\n${await page()}`, isError: true };
    }
  };

  const handlers: Record<string, ToolHandler> = {
    navigate: { schema: Inputs.navigate, run: (raw) => guarded(() => controller.navigate(Inputs.navigate.parse(raw).url)) },
    click: { schema: Inputs.click, run: (raw) => guarded(() => controller.click(toTarget(Inputs.click.parse(raw).target))) },
    scroll: {
      schema: Inputs.scroll,
      run: async (raw) => {
        await controller.scroll({ direction: Inputs.scroll.parse(raw).direction });
        return { content: await page() };
      },
    },
    observe_page: { schema: Inputs.observe_page, run: async () => ({ content: await page() }) },
    note: {
      schema: Inputs.note,
      run: async (raw) => {
        notes.push(Inputs.note.parse(raw));
        return { content: "Noted." };
      },
    },
    finish_discovery: {
      schema: Inputs.finish_discovery,
      run: async (raw) => {
        summary = Inputs.finish_discovery.parse(raw).summary;
        return { content: "Done.", done: true };
      },
    },
  };

  const session = input.provider.startAgentSession({ system: loadPrompt("discovery"), tools: TOOLS });
  await runToolLoop(
    session,
    `${formatProductContext(input.product)}\n\n# Budget\nVisit at most ${input.maxPages} pages.\n\n# Current page\n${await page()}`,
    handlers,
    {
      maxIterations: input.maxIterations,
      deadline: Date.now() + input.maxDurationS * 1000,
      log: input.log,
      nudge: "Keep exploring with the tools, or call finish_discovery.",
    },
  );

  const notesText = notes.map((n) => `- [${n.area}] ${n.observation}`).join("\n") || "(no notes)";
  const report = await input.provider.generateStructuredOutput({
    system: loadPrompt("discovery-report"),
    prompt: `${formatProductContext(input.product)}\n\n# Pages visited\n${[...visited].join("\n")}\n\n# Exploration notes\n${notesText}\n\n# Explorer summary\n${summary || "(none)"}`,
    schema: DiscoveryReportSchema,
    schemaName: "discovery_report",
  });
  return { report, visited: [...visited], notes };
}
