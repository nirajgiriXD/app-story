import { inflateRawSync } from "node:zlib";
import type { Expectation, Step, Target, Workflow } from "@app-story/contracts";
import { AppStoryError } from "@app-story/shared";
import { assembleWorkflow } from "@app-story/workflow";

/*
 * `app-story import`: a Playwright trace (`npx playwright test --trace on`, or
 * `context.tracing`) becomes a saved plan. The flow is already proven to work: actions,
 * locators and checks are taken from the trace as they are; nothing is guessed and no AI
 * is involved. What cannot be carried over is left out and said so.
 */

export interface ImportedPlan {
  workflow: Workflow;
  /** What was left out or approximated, for the person to review. */
  notes: string[];
}

/** One recorded API call of the trace: what was called on which locator. */
interface TraceCall {
  class: string;
  method: string;
  params: Record<string, unknown>;
  failed: boolean;
}

// ------------------------------------------------------------------ zip

/** The files of a zip archive (stored or deflated entries; enough for trace.zip). */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new AppStoryError("CONFIG_INVALID", "This is not a zip file (a Playwright trace is a .zip).");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new AppStoryError("CONFIG_INVALID", "The trace's zip directory is damaged.");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (compressed === 0xffffffff || local === 0xffffffff) throw new AppStoryError("CONFIG_INVALID", "The trace is too large to read (zip64).");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    // Other compression methods are not used by Playwright; such entries are skipped.
  }
  return files;
}

// ------------------------------------------------------------- locators

/** A quoted value of Playwright's selector syntax, e.g. `"Sign in"i`: the text and whether it must match exactly. */
function quoted(text: string): { value: string; exact: boolean } | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"([is]?)$/.exec(text.trim());
  if (!match) return undefined;
  return { value: JSON.parse(`"${match[1] as string}"`) as string, exact: match[2] === "s" };
}

/**
 * A Playwright selector as an AppStory target. Covers the locators people write
 * (getByRole, getByLabel, getByText, getByPlaceholder, getByTestId, CSS, .nth/.first);
 * chained or combined locators (`.filter`, `.or`, `.and`, frames) are not supported.
 */
export function selectorToTarget(selector: string): { target?: Target; problem?: string } {
  let rest = selector.trim();
  let nth: number | undefined;
  const nthMatch = /\s*>>\s*nth=(-?\d+)$/.exec(rest);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    rest = rest.slice(0, nthMatch.index);
    if (nth < 0) return { problem: `.last() or a negative index (${selector})` };
  }
  if (/>>/.test(rest) || /internal:(has|has-not|has-text|has-not-text|or|and|chain|control)=/.test(rest)) {
    return { problem: `a chained or combined locator (${selector})` };
  }
  const withNth = (target: Target): { target: Target } => ({ target: nth === undefined ? target : { ...target, nth } });

  const role = /^internal:role=([a-z]+)(.*)$/.exec(rest);
  if (role) {
    const target: Target = { role: role[1] as string };
    for (const [, key, value] of (role[2] ?? "").matchAll(/\[([a-z-]+)(?:=((?:"(?:[^"\\]|\\.)*"[is]?)|[^\]]*))?\]/g)) {
      if (key === "name" && value) {
        const name = quoted(value);
        if (!name) return { problem: `a role name that is a pattern (${selector})` };
        target.name = name.value;
        if (name.exact) target.exact = true;
      } else if (key !== "include-hidden") {
        return { problem: `a role option other than its name (${selector})` };
      }
    }
    return withNth(target);
  }
  const engine = /^internal:(label|text)=(.+)$/.exec(rest);
  if (engine) {
    const value = quoted(engine[2] as string);
    if (!value) return { problem: `a text pattern (${selector})` };
    return withNth({ [engine[1] as "label" | "text"]: value.value, ...(value.exact ? { exact: true } : {}) });
  }
  const attr = /^internal:(attr|testid)=\[([a-z-]+)=(.+)\]$/.exec(rest);
  if (attr) {
    const value = quoted(attr[3] as string);
    if (!value) return { problem: `an attribute pattern (${selector})` };
    if (attr[1] === "testid") return withNth({ test_id: value.value });
    if (attr[2] === "placeholder") return withNth({ placeholder: value.value, ...(value.exact ? { exact: true } : {}) });
    return withNth({ css: `[${attr[2]}=${JSON.stringify(value.value)}${value.exact ? "" : " i"}]` });
  }
  if (/^internal:|^(xpath|text|id|data-testid)=/.test(rest)) return { problem: `a locator AppStory cannot use (${selector})` };
  return withNth({ css: rest.replace(/^css=/, "") });
}

function targetName(target: Target): string {
  return target.name ?? target.label ?? target.text ?? target.placeholder ?? target.test_id ?? target.css ?? target.role ?? "the element";
}

// ---------------------------------------------------------------- calls

/** Every Playwright API call in the trace, in order, with whether it failed. */
export function traceCalls(files: Map<string, Buffer>): { calls: TraceCall[]; title?: string } {
  const calls: TraceCall[] = [];
  let title: string | undefined;
  // The browser's events are in `<n>-trace.trace`; `test.trace` only mirrors them for the report.
  const traces = [...files.keys()].filter((n) => /(^|\/)(\d+-)?trace\.trace$/.test(n)).sort();
  if (traces.length === 0) throw new AppStoryError("CONFIG_INVALID", "This zip holds no Playwright trace (no *.trace file inside).");
  for (const name of traces) {
    const before = new Map<string, TraceCall>();
    for (const line of (files.get(name) as Buffer).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === "context-options" && typeof event.title === "string") title ??= event.title;
      if (event.type === "before" && typeof event.class === "string" && typeof event.method === "string") {
        const call = { class: event.class, method: event.method, params: (event.params ?? {}) as Record<string, unknown>, failed: false };
        before.set(String(event.callId), call);
        calls.push(call);
      }
      if (event.type === "after" && event.error) {
        const call = before.get(String(event.callId));
        if (call) call.failed = true;
      }
    }
  }
  return { calls, title };
}

/** A URL from the trace as a path in the product (its host is the product file's `url`). */
function toPath(url: string, notes: string[]): string {
  if (!/^https?:\/\//i.test(url)) return url;
  const u = new URL(url);
  notes.push(`${url} is opened as ${u.pathname}${u.search} on the product's own address.`);
  return `${u.pathname}${u.search}`;
}

/** A plain string from a regular expression that only matches it (`projects\/new`), else undefined. */
function literalOf(regex: string): string | undefined {
  const literal = regex.replace(/\\([/.\-?&=#])/g, "$1");
  return /[\\^$*+?()[\]{}|]/.test(literal) ? undefined : literal;
}

function expectationOf(call: TraceCall, notes: string[]): Expectation | undefined {
  const p = call.params;
  const expression = String(p.expression ?? "");
  const isNot = p.isNot === true;
  const first = (p.expectedText as { string?: string; regexSource?: string }[] | undefined)?.[0];
  const text = first?.string ?? (first?.regexSource ? literalOf(first.regexSource) : undefined);
  const located = typeof p.selector === "string" ? selectorToTarget(p.selector) : undefined;
  const skip = (why: string) => {
    notes.push(`Left out a check (${expression}${isNot ? ", negated" : ""}): ${why}.`);
    return undefined;
  };
  if (located?.problem) return skip(located.problem);
  const target = located?.target;
  switch (expression) {
    case "to.be.visible":
      if (!target) return skip("no element");
      return { type: isNot ? "hidden" : "visible", target, description: `${targetName(target)} is ${isNot ? "hidden" : "visible"}` };
    case "to.be.hidden":
      if (!target) return skip("no element");
      return { type: isNot ? "visible" : "hidden", target, description: `${targetName(target)} is ${isNot ? "visible" : "hidden"}` };
    case "to.have.text":
    case "to.contain.text":
      if (!text) return skip("its text is a pattern");
      if (target) notes.push(`The check for "${text}" in ${targetName(target)} looks for it anywhere on the page.`);
      return { type: isNot ? "text_absent" : "text_present", text, description: `the page ${isNot ? "no longer shows" : "shows"} "${text}"` };
    case "to.have.url":
      if (!text || isNot) return skip("its address is a pattern");
      return { type: "url_contains", text, description: `the address contains ${text}` };
    case "to.have.title":
      if (!text || isNot) return skip("its title is a pattern");
      return { type: "title_contains", text, description: `the title contains "${text}"` };
    case "to.have.value": {
      const value = first?.string;
      if (!target || value === undefined || isNot) return skip("no exact value");
      return { type: "value_equals", target, value, description: `${targetName(target)} holds "${value}"` };
    }
    case "to.have.count": {
      const count = Number(p.expectedNumber);
      if (!target || !Number.isInteger(count) || isNot) return skip("no exact count");
      return { type: "count_at_least", target, count, description: `at least ${count} × ${targetName(target)}` };
    }
    default:
      return skip("AppStory has no matching check");
  }
}

const PASSWORD_LIKE = /pass(word|code)|\bpin\b|secret|otp|one-time/i;

/** A step for one call, or undefined when it is not a step (or cannot be carried over). */
function stepOf(call: TraceCall, notes: string[]): Step | undefined {
  const p = call.params;
  const id = "x";
  if (call.class === "Frame" && call.method === "goto" && typeof p.url === "string") {
    const url = toPath(p.url, notes);
    return { id, action: "navigate", url, description: `Open ${url}` };
  }
  if (call.class === "Page" && call.method === "keyboardPress" && typeof p.key === "string") {
    return { id, action: "press", key: p.key, description: `Press ${p.key}` };
  }
  if (call.class === "Frame" && call.method === "expect") {
    const expected = expectationOf(call, notes);
    return expected ? { id, action: "assert", expected, description: `Check that ${expected.description}` } : undefined;
  }
  if (call.class !== "Frame" || typeof p.selector !== "string") return undefined;
  const actions: Record<string, Step["action"]> = {
    click: "click",
    dblclick: "click",
    tap: "click",
    fill: "fill",
    type: "fill",
    selectOption: "select",
    check: "check",
    uncheck: "uncheck",
    setChecked: p.checked === false ? "uncheck" : "check",
    hover: "hover",
    press: "press",
  };
  const action = actions[call.method];
  if (!action) {
    if (
      !/^(waitFor|query|textContent|innerText|innerHTML|getAttribute|inputValue|isVisible|isHidden|isChecked|isEnabled|evaluate|boundingBox|screenshot)/.test(
        call.method,
      )
    ) {
      notes.push(`Left out ${call.method} on ${p.selector}: AppStory has no matching step.`);
    }
    return undefined;
  }
  const located = selectorToTarget(p.selector);
  if (!located.target) {
    notes.push(`Left out a ${call.method}: ${located.problem}.`);
    return undefined;
  }
  const target = located.target;
  const name = targetName(target);
  if (call.method === "dblclick") notes.push(`The double click on "${name}" is a single click.`);
  switch (action) {
    case "fill": {
      const value = String(p.value ?? p.text ?? "");
      return { id, action, target, value, description: `Type into "${name}"` };
    }
    case "select": {
      const option = (p.options as { valueOrLabel?: string; label?: string; value?: string }[] | undefined)?.[0];
      const value = option?.label ?? option?.valueOrLabel ?? option?.value;
      if (value === undefined) {
        notes.push(`Left out a choice in "${name}": no option given.`);
        return undefined;
      }
      return { id, action, target, value, description: `Choose "${value}" in "${name}"` };
    }
    case "press":
      // A key pressed on a locator: focus it first, then press.
      notes.push(`The key ${String(p.key)} pressed on "${name}" is pressed on whatever has the focus.`);
      return { id, action, key: String(p.key), description: `Press ${String(p.key)}` };
    case "check":
    case "uncheck":
      return { id, action, target, description: `${action === "check" ? "Tick" : "Untick"} "${name}"` };
    case "hover":
      return { id, action, target, description: `Point at "${name}"` };
    default:
      return { id, action, target, description: `Click "${name}"` };
  }
}

/** True for a step that types a password (or another secret) into a field. */
function typesASecret(step: Step): boolean {
  if (step.action !== "fill" || !step.target) return false;
  const t = step.target;
  return [t.label, t.placeholder, t.name, t.css, t.test_id].some((v) => v && PASSWORD_LIKE.test(v));
}

/** The test's own title, without its file and line ("create.spec.ts:2 › create a project"). */
function cleanTitle(title: string | undefined): string | undefined {
  const last = title
    ?.split("›")
    .pop()
    ?.trim()
    .replace(/^should\s+/i, "");
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : undefined;
}

/**
 * Turn a Playwright trace into a plan. AppStory logs in by itself, so a login the test did
 * (up to its submit) is left out, and a password is never written into the plan.
 */
export function planFromTrace(zip: Buffer, options: { title?: string; objective?: string } = {}): ImportedPlan {
  const notes: string[] = [];
  const { calls, title: traced } = traceCalls(readZip(zip));
  let steps = calls.filter((c) => !c.failed).flatMap((c) => stepOf(c, notes) ?? []);
  const failed = calls.filter((c) => c.failed && c.class === "Frame").length;
  if (failed) notes.push(`${failed} call(s) failed in the trace and were left out.`);

  const secret = steps.findIndex(typesASecret);
  if (secret >= 0) {
    // The test's login, up to the click or key that submits it.
    const submit = steps.findIndex((s, i) => i > secret && (s.action === "click" || s.action === "press"));
    const end = submit >= 0 ? submit : secret;
    notes.push(`Left out the test's login (${end + 1} step(s)): AppStory logs in by itself with "login:" in the product file.`);
    steps = steps.slice(end + 1);
  }
  // Values that only make sense typed into a secret field anywhere else are never kept either.
  steps = steps.filter((s) => {
    if (!typesASecret(s)) return true;
    notes.push(`Left out typing into "${targetName(s.target as Target)}": it looks like a secret.`);
    return false;
  });
  if (steps.length === 0) throw new AppStoryError("CONFIG_INVALID", "The trace has no steps AppStory can replay.", { hint: notes.join("\n") || undefined });

  const title = options.title ?? cleanTitle(traced) ?? "Imported flow";
  const objective = options.objective ?? `Show how to ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  const workflow = assembleWorkflow({
    title,
    objective,
    steps,
    createdBy: "human",
    source: { provider: "playwright-trace", created_at: new Date().toISOString() },
  });
  return { workflow, notes };
}
