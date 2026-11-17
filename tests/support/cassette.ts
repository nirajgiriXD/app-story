import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AiProviderConfig } from "@app-story/contracts";
import {
  createAIProvider,
  type AIProvider,
  type AIProviderFactory,
  type AgentSession,
  type AgentTurnResult,
  type ProviderDeps,
  type TokenUsage,
} from "@app-story/ai";

/*
 * Real AI answers, recorded once and replayed in tests: the full flow runs on every push,
 * for free and the same way every time.
 *
 * Record (needs a key, costs money):  APP_STORY_RECORD_AI=1 npm run test:e2e
 * Replay (no key, no network):        npm run test:e2e
 *
 * Answers are replayed in the order they were given, per kind of request (plain text,
 * each structured schema, each agent conversation), so the requests themselves (which
 * include page snapshots) do not have to match byte for byte. If the app or a prompt
 * changes so much that the replayed clicks no longer fit, record again.
 */

type UsageCall = { provider: string; model: string; usage: TokenUsage };
type Answer<T> = { response: T; usage: UsageCall[] };

interface Tape {
  name: AIProvider["name"];
  model: string;
  text: Answer<string>[];
  structured: Record<string, Answer<unknown>[]>;
  /** One list of turns per agent conversation, in the order the conversations started. */
  sessions: Answer<AgentTurnResult>[][];
}

type CassetteFile = { version: 1; providers: Record<string, Tape> };

export interface Cassette {
  readonly mode: "record" | "replay";
  /** Use as `providers.createAI`. */
  readonly createAI: AIProviderFactory;
  /** Write what was recorded (does nothing when replaying). */
  save(): Promise<void>;
}

export function isRecordingAI(): boolean {
  return process.env.APP_STORY_RECORD_AI === "1";
}

export function hasCassette(file: string): boolean {
  return existsSync(file);
}

export function openCassette(file: string, mode: "record" | "replay"): Cassette {
  const data: CassetteFile = mode === "replay" ? (JSON.parse(readFileSync(file, "utf8")) as CassetteFile) : { version: 1, providers: {} };
  const positions = new Map<string, number>();

  const createAI: AIProviderFactory = (config, deps) => {
    if (mode === "record") {
      data.providers[config.provider] ??= { name: config.provider, model: "", text: [], structured: {}, sessions: [] };
      const tape = data.providers[config.provider] as Tape;
      return recorder(createAIProvider(config, { ...deps, usage: capturing(deps) }), tape);
    }
    const tape = data.providers[config.provider];
    if (!tape) throw new Error(`${file} has no answers from ${config.provider}; record them with APP_STORY_RECORD_AI=1.`);
    return player(tape, config, deps, positions, file);
  };

  return {
    mode,
    createAI,
    async save() {
      if (mode !== "record") return;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(data, null, 1)}\n`);
    },
  };
}

// ---------------------------------------------------------------- recording

/** The usage the real provider reports during one call, so a replay can report the same. */
const captured = new AsyncLocalStorage<UsageCall[]>();

function capturing(deps: ProviderDeps): ProviderDeps["usage"] {
  return new Proxy(deps.usage, {
    get(target, prop) {
      if (prop === "record") {
        return (provider: string, model: string, usage: TokenUsage, ...rest: unknown[]) => {
          captured.getStore()?.push({ provider, model, usage });
          return (target.record as (...args: unknown[]) => void).call(target, provider, model, usage, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function capture<T>(run: () => Promise<T>): Promise<Answer<T>> {
  const usage: UsageCall[] = [];
  const response = await captured.run(usage, run);
  return { response, usage };
}

function recorder(real: AIProvider, tape: Tape): AIProvider {
  tape.model = real.model;
  return {
    name: real.name,
    model: real.model,
    async generateText(request) {
      const answer = await capture(() => real.generateText(request));
      tape.text.push(answer);
      return answer.response;
    },
    async generateStructuredOutput(request) {
      const answer = await capture(() => real.generateStructuredOutput(request));
      tape.structured[request.schemaName] ??= [];
      tape.structured[request.schemaName]?.push(answer);
      return answer.response;
    },
    startAgentSession(request): AgentSession {
      const session = real.startAgentSession(request);
      const turns: Answer<AgentTurnResult>[] = [];
      tape.sessions.push(turns);
      return {
        async send(input) {
          const answer = await capture(() => session.send(input));
          turns.push(answer);
          return answer.response;
        },
      };
    },
  };
}

// ---------------------------------------------------------------- replaying

function player(tape: Tape, config: AiProviderConfig, deps: ProviderDeps, positions: Map<string, number>, file: string): AIProvider {
  const next = <T>(key: string, list: Answer<T>[] | undefined): T => {
    const at = positions.get(key) ?? 0;
    const answer = list?.[at];
    if (!answer) throw new Error(`${file} has no more ${key} answers (${at} used); the flow changed, so record again with APP_STORY_RECORD_AI=1.`);
    positions.set(key, at + 1);
    for (const u of answer.usage) deps.usage.record(u.provider, u.model, u.usage, config.pricing);
    return structuredClone(answer.response);
  };
  return {
    name: tape.name,
    model: tape.model,
    async generateText() {
      return next("text", tape.text);
    },
    async generateStructuredOutput(request) {
      return request.schema.parse(next(`structured:${request.schemaName}`, tape.structured[request.schemaName]));
    },
    startAgentSession(): AgentSession {
      const index = positions.get("sessions") ?? 0;
      positions.set("sessions", index + 1);
      const turns = tape.sessions[index];
      return {
        async send() {
          return next(`session ${index}`, turns);
        },
      };
    },
  };
}
