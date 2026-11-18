import { setLogDisplay, type LogRecord } from "@app-story/shared";
import { bold, dim, green, red, yellow } from "./output";

/*
 * The live progress display: one line per running task, updated in place,
 *
 *   ⠹ 0:12 Recording · create-project: ✓ Click "Save"
 *
 * and frozen as `✔ 41.2s …` or `✖ 3.1s …` when the task ends. A task is a stage of a job
 * (see STAGE_TITLES in core), announced by a log line with a `stage` field; any other line
 * becomes the task's status, and warnings stay printed above the live lines. Several videos
 * made at once each get a line. `--verbose`, and any output that is not a terminal (CI, a
 * file), print every log line as before instead.
 */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
const INFO = 30;
const WARN = 40;
const ERROR = 50;

interface Task {
  title: string;
  video?: string;
  status: string;
  startedAt: number;
}

/** What the display shows, from the log lines it is given. Pure: no terminal, no clock of its own. */
export class ProgressView {
  /** One running task per job (or `main`, for log lines outside a job). */
  private readonly running = new Map<string, Task>();
  /** The jobs on screen, in the order they first showed: a job keeps its row from stage to stage. */
  private rows: string[] = [];
  /** Lines to print once, above the live ones: finished tasks and warnings. */
  private pending: string[] = [];

  handle(record: LogRecord, now: number): void {
    const key = typeof record.job === "string" ? record.job : "main";
    const video = typeof record.video === "string" ? record.video : undefined;
    const stage = typeof record.stage === "string" ? record.stage : undefined;
    if (stage === "end") {
      const ok = record.ok !== false;
      this.finish(key, now, ok, ok ? undefined : stringField(record.error));
      this.rows = this.rows.filter((row) => row !== key);
      return;
    }
    if (stage) {
      this.finish(key, now, true);
      this.start(key, { title: record.msg, video, status: "", startedAt: now });
      return;
    }
    if (record.level >= WARN) {
      const text = describe(record);
      const task = this.running.get(key);
      if (record.level >= ERROR && task) task.status = text;
      else this.pending.push(`  ${yellow("!")} ${video ? dim(`${video}: `) : ""}${text}`);
      return;
    }
    if (record.level < INFO) return;
    const task = this.running.get(key) ?? this.start(key, { title: "Working", video, status: "", startedAt: now });
    task.status = describe(record);
  }

  /** Every running task ends as it is (the command is over). */
  finishAll(now: number): void {
    for (const key of [...this.running.keys()]) this.finish(key, now, true);
    this.rows = [];
  }

  /** The lines to print for good since the last call, and the live lines as they are now. */
  frame(now: number, width: number): { done: string[]; live: string[] } {
    const done = this.pending;
    this.pending = [];
    const spin = SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] as string;
    const tasks = this.rows.flatMap((key) => this.running.get(key) ?? []);
    const live = tasks.map((task) => line(yellow(spin), clock(now - task.startedAt), task, width));
    return { done, live };
  }

  private start(key: string, task: Task): Task {
    this.running.set(key, task);
    if (!this.rows.includes(key)) this.rows.push(key);
    return task;
  }

  private finish(key: string, now: number, ok: boolean, error?: string): void {
    const task = this.running.get(key);
    if (!task) return;
    this.running.delete(key);
    if (error) task.status = error;
    this.pending.push(line(ok ? green("✔") : red("✖"), took(now - task.startedAt), task, Number.POSITIVE_INFINITY));
  }
}

/** `<icon> <time> <title> · <video>: <status>`, cut to the terminal's width so it never wraps. */
function line(icon: string, time: string, task: Task, width: number): string {
  const head = `${time.padStart(6)} ${task.title}${task.video ? ` · ${task.video}` : ""}`;
  const room = width - 2 - head.length - 2;
  const status = task.status ? cut(task.status, room) : "";
  const title = `${bold(task.title)}${task.video ? dim(` · ${task.video}`) : ""}`;
  return `${icon} ${dim(time.padStart(6))} ${title}${status ? `: ${status}` : ""}`;
}

function cut(text: string, room: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (room <= 1) return "";
  return flat.length <= room ? flat : `${flat.slice(0, room - 1)}…`;
}

/** A log line as a status: its message, with the one detail worth knowing when there is one. */
function describe(record: LogRecord): string {
  const detail = stringField(record.error) ?? stringField(record.clip) ?? stringField(record.language) ?? stringField(record.format);
  return detail ? `${record.msg} (${detail})` : record.msg;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.split("\n")[0] : undefined;
}

/** A running task's time: 0:12, 1:05. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How long a finished task took: 3.1s, 1m 05s. */
function took(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

// ------------------------------------------------------------------ the terminal

interface Live {
  view: ProgressView;
  timer: NodeJS.Timeout;
  /** How many live lines are on screen now. */
  drawn: number;
  write: { out: typeof process.stdout.write; err: typeof process.stderr.write };
}

let live: Live | undefined;

/** Whether to show live lines: in a terminal, unless `--verbose` or CI asked for every log line. */
export function wantsLiveProgress(verbose: boolean | undefined): boolean {
  return !verbose && Boolean(process.stdout.isTTY) && !process.env.CI;
}

/** Show progress as live lines from now on, if `wantsLiveProgress`. */
export function startProgress(options: { verbose?: boolean }): void {
  if (live || !wantsLiveProgress(options.verbose)) return;
  const view = new ProgressView();
  setLogDisplay((record) => view.handle(record, Date.now()));
  const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  live = { view, timer: setInterval(draw, FRAME_MS).unref(), drawn: 0, write };
  capture(live);
}

/** End the display: running tasks are printed as they are, and the terminal is left as it was. */
export function stopProgress(): void {
  if (!live) return;
  const current = live;
  current.view.finishAll(Date.now());
  draw();
  clearInterval(current.timer);
  release(current);
  setLogDisplay(undefined);
  live = undefined;
}

/** Run `ask` with the live lines out of the way, e.g. a question asked in the terminal. */
export async function pauseProgress<T>(ask: () => Promise<T>): Promise<T> {
  if (!live) return ask();
  const current = live;
  clearInterval(current.timer);
  draw(false);
  release(current);
  try {
    return await ask();
  } finally {
    if (live === current) {
      capture(current);
      current.timer = setInterval(draw, FRAME_MS).unref();
    }
  }
}

/** Print what finished since the last frame, then the live lines (unless `withLive` is false). */
function draw(withLive = true): void {
  if (!live) return;
  const { done, live: lines } = live.view.frame(Date.now(), process.stdout.columns || 100);
  const shown = withLive ? lines : [];
  if (done.length === 0 && shown.length === 0 && live.drawn === 0) return;
  live.write.out(clear(live.drawn) + [...done, ...shown].map((l) => `${l}\n`).join(""));
  live.drawn = shown.length;
}

/** Move up over the live lines and clear them. */
function clear(lines: number): string {
  return lines > 0 ? `\x1b[${lines}A\r\x1b[J` : "";
}

/** Anything else written (a summary, a library's warning) goes above the live lines. */
function capture(current: Live): void {
  process.stdout.write = passThrough(current.write.out) as typeof process.stdout.write;
  process.stderr.write = passThrough(current.write.err) as typeof process.stderr.write;
}

function release(current: Live): void {
  process.stdout.write = current.write.out;
  process.stderr.write = current.write.err;
}

/** A write that first takes the live lines away (printing what finished), then puts them back below it. */
function passThrough(original: (chunk: string | Uint8Array, ...rest: never[]) => boolean) {
  return (chunk: string | Uint8Array, ...rest: never[]): boolean => {
    if (!live) return original(chunk, ...rest);
    draw(false);
    const result = original(chunk, ...rest);
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    // A question waiting on the same line keeps it: the live lines come back with the next frame.
    if (text.endsWith("\n")) draw();
    return result;
  };
}
