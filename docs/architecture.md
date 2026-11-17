# Architecture

All code lives in `engine/`: the CLI in `engine/cli`, the packages in `engine/packages/`.

```text
cli ──► core (orchestrator, pipeline stages, job manager, QA, SQLite store)
        │
        ├─ products   product file reader (settings block + Markdown), plan YAML
        ├─ ai         provider interface, Anthropic + OpenAI, agents, prompts, tools
        ├─ workflow   step executor, validators, workflow assembly
        ├─ browser    Playwright session, controller, locators, guards, recorders
        ├─ narration  script writer, TTS providers, narration pacer
        ├─ captions   cue builder, SRT / WebVTT
        └─ video      React compositions, templates, timeline maths, render
  contracts (Zod schemas)  ·  shared (errors, logging, secrets, FFmpeg helpers)
```

Packages export TypeScript sources directly and run through `tsx`, so working on them needs
no build step. The npm package `app-story` is built by `npm run build`
(`engine/scripts/build-package.ts`): esbuild bundles the CLI and the engine's packages
into one file, with the render page bundled ahead of time and the prompts next to it;
everything from npm stays a dependency. The Docker image (`Dockerfile`) installs that
package with FFmpeg, Chromium and the Kokoro voice model.

AppStory never keeps user data in its own folder. Everything belongs to the user's
project folder (`workspace()` in the shared package): the nearest folder with
`products/` or `.app-story/`, or `APP_STORY_HOME`.

## Product files

`products/<id>.md` is the only thing users write. Its settings block (YAML between `---`
lines) is validated with Zod and turned into the engine's full `ProductConfig`, with
defaults for everything else; it is never sent to the AI. The Markdown below it is the
product context every AI step reads. Logins are filled by `autoLogin` (in the browser
package), which finds the password field itself; `env:NAME` values are read from `.env`
at login time and registered as secrets.

## Pipeline (`npx app-story <product>`)

0. **Features.** Without a goal, one structured AI call reads the product file and picks
   the new user-visible features from its release notes (`planFeatures`). Each becomes an
   objective, for one video or one each.
1. **Plan.** A saved plan (`products/<product>.plans/<name>.yaml`) is replayed if it was made for exactly this
   objective. Otherwise a **rehearsal** runs: the AI drives an *unrecorded* browser through
   guarded tools, recovers from mistakes, verifies the outcome, then picks the successful
   steps to keep. The result is a versioned workflow (the `plan` record).
2. **Static validation.** Domains, sensitive actions and at least one verification.
3. **Narration.** Script from the verified steps (AI, or the scenario's own `narration`
   lines). The writer sees what each step types and proves, and roughly how long it is on
   screen (`estimateStepMs`), so each line fits its steps and the recording never freezes
   waiting for the voice; `length` is only an upper bound. Then text-to-speech per line,
   two-pass loudness-normalised, kept as WAV until the final encode, and measured.
4. **Recording.** A fresh browser replays the workflow at presentation speed: smooth
   cursor, typed input, minimum dwell per step, and each narration line starts with its
   first step while the next line waits for the previous one to finish. Every step is
   verified again. After every action the controller waits until the page stops changing
   (no DOM mutations or loading requests for 300 ms, capped at 2.5 s); off-screen elements
   glide into view. The take is captured at 2x and stored lossless (4:4:4, BT.709), so the
   zoom stays sharp and the final encode is the only lossy one. If a *saved* plan fails
   here, it is dropped and the demo is planned again once, in the same job; any other
   failure stops the job and no video is made.
5. **Captions + render.** Narration is placed on the final timeline (intro card →
   recording → outro card), captions are cut from it, and the video is rendered with
   zoom-to-element, cursor highlight, click ripples, chapter chips and branding. The
   compositions (React) are bundled once per process with esbuild. The frames are split
   into stretches, one per worker (`APP_STORY_RENDER_WORKERS`, default one per two CPU
   cores, up to 8). Each worker draws its frames in a headless Chromium tab, with FFmpeg
   streaming it the recording's frames and encoding the captured frames to H.264 (JPEG
   quality 100, BT.709). FFmpeg then joins the stretches without re-encoding and mixes
   the sound: each voice clip at its place, and the music looped under it, dipping
   under the voice. The thumbnail is a frame of the finished MP4.
6. **Quality checks** and **metadata**. A plan made by the AI is saved for reuse only
   after its video passed. Videos are never published automatically.

## Storage

`output/` receives only the finished MP4 and its captions (`.srt`). A plan made by the AI is saved, after its video
passed, as YAML next to the product file (`products/<product>.plans/<name>.yaml`, see
`pipeline/plans.ts`), so it can be committed, reviewed and shared. Everything else is in
`.app-story/` in the user's project, which ignores itself in git:

- `app-story.db`, one SQLite file through Node's built-in `node:sqlite` (`Store` in
  `engine/packages/core/src/store/`): a `jobs` table with each job's metadata,
  `job_records` with everything a job produces (settings used, plan, practice run,
  narration, captions, reports, quality checks, log, thumbnail), and `cache` with results
  that are identical for identical inputs: the feature list of a product file, the
  narration of a plan, and spoken clips by voice and text.
- `takes/<job>/`: the take of each of the 5 newest videos per product (`pipeline/takes.ts`):
  the raw recording, the spoken clips, the plan and the recording's timeline. `redo`
  (`orchestrator/redo.ts`) renders a take again with the product file's current look,
  without a browser or the AI. The take is kept before rendering, so a video whose render
  failed can be redone too.
- `work/<job>/`: where a job works; deleted on success and kept on failure for
  troubleshooting.

## Decisions that differ from a literal reading of the spec

These were chosen deliberately (and agreed before building):

- **Rehearse, then record** instead of recording the agent live. Live recording captures
  model think-time and wrong clicks. The rehearsal also produces the plan that later
  videos replay.
- **CDP screencast + FFmpeg** instead of Playwright's `recordVideo`, which records at a
  low fixed bitrate. Frames come straight from Chromium at the real device pixel size.
  `recording.engine: playwright` remains available.
- **Agent sessions** in the provider interface: `startAgentSession()` returns a session
  whose `send()` replaces `executeAgentTurn()`. Each provider keeps its native history
  inside the session (Claude's thinking blocks, OpenAI's `previous_response_id`), so no
  provider message format leaks out.
- **Chapter titles as overlays.** Sections appear as animated chips above the app
  window instead of full-screen cards that would cut the recording and break audio sync.

## AI providers

`AIProvider` (in `engine/packages/ai/src/contracts/types.ts`) has `generateText`,
`generateStructuredOutput` (Zod in, validated object out) and `startAgentSession`
(tools as Zod schemas, strict mode on both providers, normalised tool calls).

- Anthropic: Messages API via `@anthropic-ai/sdk`, default `claude-opus-5-5`, adaptive
  thinking with `effort`, streaming agent turns, prompt caching of the agent loop.
- Effort is set per phase (`PHASE_EFFORT`: `high` for the practice run and feature
  picking, `low` for the script); `APP_STORY_AI_EFFORT` overrides all of them. The practice
  agent may call several actions in one turn (they run in order and stop at the first
  error); only the last one returns the page snapshot. Old snapshots are never trimmed
  from the history: editing past turns would invalidate Claude's preserved thinking.
  Temperature is not sent (current Claude models reject it).
- OpenAI: Responses API via `openai`, default `gpt-5`, `reasoning.effort` and
  `temperature` only when configured.
- With keys for both providers, the one not chosen is the fallback. It is triggered only
  by provider errors, and every attempt and switch is written to the job's metadata.
- New providers: `registerAIProvider(name, factory)`; TTS: `registerTTSProvider`.

## Security

- Browser actions only go through the controller. The AI has no shell or file access.
- Domain allow-list enforced twice: before `navigate`, and at the network layer for any
  frame navigation (including links the page itself follows). Popups are closed.
- Sensitive-action guard on element names (delete, payments, emails, publishing,
  account settings, invites); a product file can allow some with `allow:`. A read-only
  mode blocks all typing and button clicks.
- Page snapshots are wrapped as `<page_content>` untrusted data; the prompts tell the
  model never to follow instructions found there, and the guards apply regardless.
- Secrets come from the environment, are registered for redaction, and are scrubbed
  from logs, metadata and screenshots (password fields are masked).
- Timeouts: per action, per agent run (`max_duration_s`), iteration caps and a recording cap.
