import type { z } from "zod";
import { DemoForgeError, type Logger } from "@demoforge/shared";
import type { AgentSession, ToolCall, ToolResult } from "../contracts/types";

export interface ToolHandlerResult {
  content: string;
  isError?: boolean;
  /** Stop the loop after this call (finish / give up). */
  done?: boolean;
}

export interface ToolHandler {
  schema: z.ZodType;
  run(input: unknown, call: ToolCall): Promise<ToolHandlerResult>;
}

export interface ToolLoopOptions {
  maxIterations: number;
  /** Wall-clock deadline in ms since epoch. */
  deadline: number;
  log: Logger;
  /** Message sent when the model stops without calling a terminal tool. */
  nudge: string;
}

export interface ToolLoopResult {
  iterations: number;
  finished: boolean;
}

/**
 * Drive an agent session: send tool results back until a handler reports `done`.
 * Inputs are validated with Zod before any handler runs, so a malformed or truncated
 * tool call never reaches the browser.
 */
export async function runToolLoop(
  session: AgentSession,
  firstMessage: string,
  handlers: Record<string, ToolHandler>,
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  let turn = await session.send({ type: "user", text: firstMessage });
  let nudges = 0;

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    if (turn.stop === "refusal") {
      throw new DemoForgeError("PROVIDER_REFUSAL", "The AI model declined to continue this task.");
    }
    if (turn.text) options.log.debug({ iteration }, `agent: ${turn.text.slice(0, 300)}`);

    if (turn.toolCalls.length === 0) {
      if (nudges >= 2) return { iterations: iteration, finished: false };
      nudges += 1;
      turn = await session.send({ type: "user", text: options.nudge });
      continue;
    }
    if (turn.stop === "max_tokens") {
      // A tool call cut off at the token limit may parse but be incomplete: never run it.
      turn = await session.send({
        type: "tool_results",
        results: turn.toolCalls.map((c) => ({ callId: c.id, content: "Your output was cut off. Send a shorter tool call.", isError: true })),
      });
      continue;
    }

    const results: ToolResult[] = [];
    let done = false;
    for (const call of turn.toolCalls) {
      if (done) {
        results.push({ callId: call.id, content: "Ignored: the task already finished.", isError: true });
        continue;
      }
      const handler = handlers[call.name];
      if (!handler) {
        results.push({ callId: call.id, content: `Unknown tool "${call.name}".`, isError: true });
        continue;
      }
      const parsed = handler.schema.safeParse(call.input);
      if (!parsed.success) {
        results.push({ callId: call.id, content: `Invalid input: ${parsed.error.message}`, isError: true });
        continue;
      }
      const result = await handler.run(parsed.data, call);
      results.push({ callId: call.id, content: result.content, isError: result.isError });
      if (result.done) done = true;
    }
    if (done) return { iterations: iteration, finished: true };

    if (Date.now() > options.deadline) {
      throw new DemoForgeError("TIMEOUT", "The AI agent ran out of time before finishing.");
    }
    const remaining = options.maxIterations - iteration;
    turn = await session.send({
      type: "tool_results",
      results,
      note: remaining <= 3 && remaining > 0 ? `Only ${remaining} actions left. Finish now if the objective is verified.` : undefined,
    });
  }
  return { iterations: options.maxIterations, finished: false };
}
