import { join } from "node:path";
import type { DiscoveryReport, JobMetadata } from "@demoforge/contracts";
import { runDiscovery } from "@demoforge/ai";
import type { LoadedProduct } from "@demoforge/products";
import { writeJson, writeText } from "@demoforge/shared";
import { createJob, finishJob, recordError, type Job } from "../job-manager/job";
import { withBrowser } from "../pipeline/browser";
import { withProviderFallback, type ProviderOverrides } from "../pipeline/providers";
import { productContext } from "../pipeline/rehearse";
import { statusForError } from "../pipeline/status";

export interface DiscoverRequest {
  product: LoadedProduct;
  outputDir: string;
  maxPages?: number;
  headless?: boolean;
  logLevel?: string;
  providers?: ProviderOverrides;
  onJobCreated?: (job: Job) => void;
}

export interface DiscoverResult {
  metadata: JobMetadata;
  report?: DiscoveryReport;
  reportFile?: string;
}

/** Mode C: read-only exploration that proposes demo scenarios for human review. */
export async function discoverProduct(request: DiscoverRequest): Promise<DiscoverResult> {
  const { product } = request;
  const job = await createJob({
    outputDir: request.outputDir,
    productId: product.id,
    name: "discovery",
    mode: "discovery",
    objective: null,
    scenarioId: null,
    logLevel: request.logLevel,
  });
  request.onJobCreated?.(job);
  try {
    const result = await withProviderFallback(job, "discovery", product.config, request.providers ?? {}, (provider) =>
      withBrowser(
        product,
        // Discovery never changes data: the browser is read-only regardless of product settings.
        { phase: "discovery", workDir: join(job.paths.logsDir, "browser"), log: job.log, mode: "read_only", headless: request.headless },
        (session) =>
          runDiscovery({
            provider,
            controller: session.controller,
            product: productContext(product),
            maxPages: request.maxPages ?? 12,
            maxIterations: Math.max(product.config.providers.ai.max_iterations, 30),
            maxDurationS: product.config.providers.ai.max_duration_s,
            log: job.log,
          }),
      ),
    );
    const reportFile = join(job.paths.root, "discovery.md");
    await writeJson(join(job.paths.root, "discovery.json"), result);
    await writeText(reportFile, discoveryMarkdown(product, result.report, result.visited));
    const metadata = await finishJob(job, "success");
    return { metadata, report: result.report, reportFile };
  } catch (error) {
    recordError(job, error, "discovery");
    return { metadata: await finishJob(job, statusForError(error)) };
  }
}

function discoveryMarkdown(product: LoadedProduct, r: DiscoveryReport, visited: string[]): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  return [
    `# Discovery: ${product.config.product.name}`,
    "",
    r.overview,
    "",
    "## Navigation",
    list(r.navigation.map((n) => `${n.label} — \`${n.path}\``)),
    "",
    "## Features",
    list(r.features.map((f) => `**${f.name}** (${f.location}): ${f.description}`)),
    "",
    "## Suggested user journeys",
    list(r.journeys.map((j) => `**${j.title}**: ${j.steps.join(" → ")}`)),
    "",
    "## Proposed demos",
    "Each one is a starting point. Generate it, review the saved scenario, then approve it:",
    "",
    ...r.proposed_scenarios.map(
      (s) =>
        `- **${s.title}** (${s.audience}, ~${s.estimated_duration_s}s)\n  \`demoforge generate --product ${product.id} --objective "${s.objective.replace(/"/g, "'")}" --save-scenario\``,
    ),
    "",
    "## Missing information",
    list(r.missing_information),
    "",
    "## Recommended test data",
    list(r.recommended_test_data),
    "",
    "## Pages visited",
    list(visited),
    "",
  ].join("\n");
}
