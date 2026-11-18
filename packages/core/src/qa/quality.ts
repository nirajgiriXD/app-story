import type { AudioClip, CaptionCue, ProductConfig, QualityCheck, QualityReport, Workflow } from "@app-story/contracts";
import { RESOLUTIONS } from "@app-story/contracts";
import { fileExists, frameContrast, meanVolumeDb, probeMedia, type MediaProbe } from "@app-story/shared";
import type { TimelinePlan } from "@app-story/video";
import type { JobPaths } from "../job-manager/job";
import type { RecordingOutcome } from "../pipeline/record";

/** A still screen or a silence longer than this looks like the video got stuck. */
const LONG_PAUSE_MS = 6000;

export interface QualityInput {
  jobId: string;
  paths: JobPaths;
  config: ProductConfig;
  workflow: Workflow;
  recorded: RecordingOutcome;
  clips: AudioClip[];
  cues: CaptionCue[];
  plan: TimelinePlan;
  /** The narration track is silent on purpose (`tts.provider: none`), so captions carry the words. */
  silentNarration?: boolean;
}

/**
 * A finished recording is not proof of a good video. These checks cover the workflow,
 * the raw recording, the narration audio and the final MP4.
 */
export async function runQualityChecks(input: QualityInput): Promise<QualityReport> {
  const checks: QualityCheck[] = [];
  const add = (category: QualityCheck["category"], name: string, passed: boolean, severity: QualityCheck["severity"], detail?: string) =>
    checks.push({ category, name, passed, severity, detail });

  // --- workflow
  const { report } = input.recorded;
  const expected = input.workflow.steps.filter((s) => !s.optional);
  const results = new Map(report.steps.map((r) => [r.step_id, r]));
  const missing = expected.filter((s) => {
    const r = results.get(s.id);
    return !r || r.status === "failed";
  });
  add(
    "workflow",
    "all required steps executed",
    missing.length === 0,
    "error",
    missing.length ? `missing/failed: ${missing.map((s) => s.id).join(", ")}` : undefined,
  );

  const verifySteps = input.workflow.steps.filter((s) => s.action === "assert" || s.expected);
  const verifiedOk = verifySteps.filter((s) => {
    const r = results.get(s.id);
    return r?.status === "passed" && r.verified;
  });
  add(
    "workflow",
    "expected outcomes verified",
    verifySteps.length > 0 && verifiedOk.length === verifySteps.length,
    "error",
    `${verifiedOk.length}/${verifySteps.length} verifications passed`,
  );

  const lastStep = input.workflow.steps[input.workflow.steps.length - 1];
  add("workflow", "stopped at the intended endpoint", Boolean(lastStep && results.get(lastStep.id)?.status === "passed"), "error");

  const retried = report.steps.filter((s) => s.status === "passed" && s.attempts > 1);
  add("workflow", "no retries on camera", retried.length === 0, "warning", retried.length ? `retried: ${retried.map((s) => s.step_id).join(", ")}` : undefined);

  // The pacer holds a step back until the previous line is spoken: a long hold is a frozen screen.
  // The opening shot is left out: the first line sets the scene over the start page.
  const ran = report.steps.filter((s) => s.status !== "skipped");
  const stills = ran
    .slice(2)
    .map((s, i) => ({ id: s.step_id, ms: s.started_ms - (ran[i + 1] as (typeof ran)[number]).ended_ms }))
    .filter((g) => g.ms > LONG_PAUSE_MS);
  add(
    "recording",
    "no long still screens",
    stills.length === 0,
    "warning",
    stills.length ? stills.map((g) => `${(g.ms / 1000).toFixed(1)}s before ${g.id}`).join(", ") : undefined,
  );

  const voice = [...input.recorded.placed].sort((a, b) => a.start_ms - b.start_ms);
  const silences = voice
    .slice(1)
    .map((c, i) => {
      const prev = voice[i] as (typeof voice)[number];
      return { id: c.id, ms: c.start_ms - (prev.start_ms + prev.duration_ms) };
    })
    .filter((g) => g.ms > LONG_PAUSE_MS);
  add(
    "audio",
    "no long silences",
    silences.length === 0,
    "warning",
    silences.length ? silences.map((g) => `${(g.ms / 1000).toFixed(1)}s before ${g.id}`).join(", ") : undefined,
  );

  const blocked = report.issues.filter((i) => i.kind === "blocked_navigation");
  add("workflow", "no unexpected navigation", blocked.length === 0, "warning", blocked.map((b) => b.url).join(", ") || undefined);
  const browserErrors = unexpectedIssues(report.issues, input.config.browser.ignore_errors);
  add("workflow", "no browser errors", browserErrors.length === 0, "warning", browserErrors.length ? describeIssues(browserErrors) : undefined);

  // --- recording
  const rawProbe = await safeProbe(input.paths.rawRecording);
  add("recording", "recording present and playable", Boolean(rawProbe && rawProbe.durationSec > 0), "error");
  if (rawProbe) {
    const minSec = Math.max(3, report.steps.length * 0.5);
    add(
      "recording",
      "duration is reasonable",
      rawProbe.durationSec >= minSec && rawProbe.durationSec < 20 * 60,
      "error",
      `${rawProbe.durationSec.toFixed(1)}s`,
    );
    const vp = input.config.browser.viewport;
    const dsf = input.config.browser.device_scale_factor;
    const engine = input.config.recording.engine;
    const want = engine === "cdp" ? [vp.width * dsf, vp.height * dsf] : [vp.width, vp.height];
    add(
      "recording",
      "viewport matches configuration",
      rawProbe.width === want[0] && rawProbe.height === want[1],
      "error",
      `${rawProbe.width}x${rawProbe.height}`,
    );
    // The file can be the right size while its frames were stretched up from smaller ones.
    const source = input.recorded.recording.source;
    if (source) {
      add(
        "recording",
        "recorded at full sharpness",
        source.width >= (rawProbe.width ?? 0) && source.height >= (rawProbe.height ?? 0),
        "warning",
        `the browser sent ${source.width}x${source.height}`,
      );
    }
    // A blank (single-colour) frame at the end means the app UI was not on screen.
    const contrast = await frameContrast(input.paths.rawRecording, Math.max(0, rawProbe.durationSec - 1.5)).catch(() => undefined);
    add(
      "recording",
      "application UI visible",
      contrast === undefined || contrast > 12,
      "error",
      contrast === undefined ? "not measured" : `luma range ${contrast}`,
    );
  }

  // --- audio
  const segments = input.clips.filter((c) => c.kind === "segment");
  add("audio", "narration present", segments.length > 0, "error", `${input.clips.length} clip(s)`);
  const short = input.clips.filter((c) => c.duration_ms < 300);
  add("audio", "clip durations valid", short.length === 0, "error", short.map((c) => c.id).join(", ") || undefined);
  if (input.silentNarration) {
    add("audio", "voice-over", true, "warning", "off (no text-to-speech); captions only");
  } else {
    const silent: string[] = [];
    for (const clip of input.clips) {
      const db = await meanVolumeDb(clip.path).catch(() => undefined);
      if (db !== undefined && db < -50) silent.push(clip.id);
    }
    add("audio", "no silent narration segments", silent.length === 0, "error", silent.join(", ") || undefined);
  }
  const placedAll = segments.every((c) => input.recorded.placed.some((p) => p.id === c.id));
  add("audio", "every segment placed on the recording", placedAll, "error");
  if (input.config.captions.enabled) {
    add("audio", "captions generated", input.cues.length > 0, "error", `${input.cues.length} cue(s)`);
  }

  // --- final video
  const final = await safeProbe(input.paths.finalVideo);
  add(
    "video",
    "final MP4 valid",
    Boolean(final && final.videoCodec === "h264" && final.audioCodec === "aac"),
    "error",
    final ? `${final.videoCodec}/${final.audioCodec}` : "missing",
  );
  if (final) {
    const [w, h] = RESOLUTIONS[input.config.demo.default_resolution];
    add("video", "resolution correct", final.width === w && final.height === h, "error", `${final.width}x${final.height}`);
    const drift = Math.abs(final.durationSec * 1000 - input.plan.totalMs);
    add("video", "duration matches timeline (audio in sync)", drift < 1000, "error", `drift ${Math.round(drift)}ms`);
    // The length is a maximum: a short, tight video is fine; title cards add a few seconds.
    const target = input.config.demo.default_duration;
    add(
      "video",
      "within the requested length",
      final.durationSec <= target * 1.25 + 8,
      "warning",
      `${final.durationSec.toFixed(1)}s, at most ~${target}s requested`,
    );
  }
  const maxLine = Math.max(0, ...input.cues.flatMap((c) => c.text.split("\n").map((l) => l.length)));
  const tooFast = input.cues.filter((c) => c.end_ms - c.start_ms < 700);
  add(
    "video",
    "captions readable",
    maxLine <= input.config.captions.max_chars_per_line + 8 && tooFast.length === 0,
    "warning",
    `longest line ${maxLine} chars`,
  );
  add("video", "thumbnail generated", await fileExists(input.paths.thumbnail), "warning");

  return {
    job_id: input.jobId,
    passed: checks.every((c) => c.passed || c.severity === "warning"),
    checks,
    generated_at: new Date().toISOString(),
  };
}

async function safeProbe(path: string): Promise<MediaProbe | undefined> {
  if (!(await fileExists(path))) return undefined;
  return probeMedia(path).catch(() => undefined);
}

/** The browser's errors, without blocked navigations (checked on their own) and those `ignore errors:` expects. */
export function unexpectedIssues<T extends { kind: string; message: string; url?: string }>(issues: readonly T[], ignore: readonly string[]): T[] {
  const words = ignore.map((word) => word.toLowerCase());
  return issues.filter((i) => i.kind !== "blocked_navigation" && !words.some((word) => `${i.message} ${i.url ?? ""}`.toLowerCase().includes(word)));
}

/**
 * The browser's errors in a line: each distinct message once, with how often it came, so the
 * warning says what happened (the full list is kept with the job as `browser_issues`).
 */
export function describeIssues(issues: readonly { message: string }[], shown = 3): string {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const text = issue.message.replace(/\s+/g, " ").trim();
    const short = text.length > 90 ? `${text.slice(0, 89)}…` : text;
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  const listed = [...counts].slice(0, shown).map(([text, n]) => `"${text}"${n > 1 ? ` ×${n}` : ""}`);
  const more = counts.size > shown ? `, and ${counts.size - shown} more` : "";
  const hint = ' (expected ones can go in "ignore errors:" in the product file)';
  return `${issues.length} console/network issue(s): ${listed.join(", ")}${more}${hint}`;
}
