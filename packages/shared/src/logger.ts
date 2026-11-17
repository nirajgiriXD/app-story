import { pino, type Logger, type DestinationStream } from "pino";
import { redactSecrets } from "./secrets";

export type { Logger } from "pino";

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  /** Extra JSON-lines destination file. */
  file?: string;
  /** Also collect every debug-and-up JSON line into this array. */
  collect?: string[];
}

const REDACT_PATHS = [
  "apiKey",
  "*.apiKey",
  "password",
  "*.password",
  "token",
  "*.token",
  "headers.authorization",
  "*.headers.authorization",
  "cookie",
  "*.cookies",
];

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.APP_STORY_LOG_LEVEL ?? "info";
  const streams: { level: string; stream: DestinationStream }[] = [];

  if (options.pretty ?? process.stdout.isTTY) {
    streams.push({
      level,
      stream: pino.transport({
        target: "pino-pretty",
        options: { colorize: true, ignore: "pid,hostname", translateTime: "HH:MM:ss" },
      }),
    });
  } else {
    streams.push({ level, stream: pino.destination(1) });
  }
  if (options.file) {
    streams.push({ level: "debug", stream: pino.destination({ dest: options.file, mkdir: true, sync: false }) });
  }
  if (options.collect) {
    // Kept in memory (e.g. a job's log, saved to the database when the job ends).
    const lines = options.collect;
    streams.push({ level: "debug", stream: { write: (line: string) => void lines.push(line) } as DestinationStream });
  }

  return pino(
    {
      level: "debug",
      redact: { paths: REDACT_PATHS, censor: "***" },
      formatters: {
        // Scrub any registered secret that slipped into a log message or field.
        log: (obj) => redactSecrets(obj),
      },
      hooks: {
        logMethod(args, method) {
          method.apply(this, redactSecrets(args) as Parameters<typeof method>);
        },
      },
    },
    pino.multistream(streams),
  );
}

/** A logger that discards everything; handy in tests. */
export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}
