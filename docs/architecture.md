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
        └─ video      Remotion compositions, templates, timeline maths, render
  contracts (Zod schemas)  ·  shared (errors, logging, secrets, FFmpeg helpers)
```

Packages export TypeScript sources directly and run through `tsx`, so there is no build step.

## Product files

`products/<id>.md` is the only thing users write. Its settings block (YAML between `---`
lines) is validated with Zod and turned into the engine's full `ProductConfig`, with
defaults for everything else; it is never sent to the AI. The Markdown below it is the
product context every AI step reads. Logins are filled by `autoLogin` (in the browser
package), which finds the password field itself; `env:NAME` values are read from `.env`
at login time and registered as secrets.

## Pipeline (`npx showrun <product>`)

0. **Features.** Without a goal, one structured AI call reads the product file and picks
   the new user-visible features from its release notes (`planFeatures`). Each becomes an
   objective, for one video or one each.
1. **Plan.** A saved plan from the database is replayed if it was made for exactly this
   objective. Otherwise a **rehearsal** runs: the AI drives an *unrecorded* browser through
   guarded tools, recovers from mistakes, verifies the outcome, then picks the successful
   steps to keep. The result is a versioned workflow (the `plan` record).
2. **Static validation.** Domains, sensitive actions and at least one verification.
3. **Narration.** Script from the verified steps (AI, or the scenario's own `narration`
   lines), then text-to-speech per line, loudness-normalised and measured.
4. **Recording.** A fresh browser replays the workflow at presentation speed: smooth
   cursor, typed input, minimum dwell per step, and each narration line starts with its
   first step while the next line waits for the previous one to finish. Every step is
   verified again. If a *saved* plan fails here, it is dropped and the demo is planned
   again once, in the same job; any other failure stops the job and no video is made.
5. **Captions + render.** Narration is placed on the final timeline (intro card →
   recording → outro card), captions are cut from it, and Remotion renders H.264/AAC
   with zoom-to-element, cursor highlight, click ripples, chapter chips and branding.
6. **Quality checks** and **metadata**. A plan made by the AI is saved for reuse only
   after its video passed. Videos are never published automatically.

## Storage

`output/` receives only the finished MP4. Everything else is in one SQLite file,
`engine/data/showrun.db`, through Node's built-in `node:sqlite` (`Store` in
`engine/packages/core/src/store/`): a `jobs` table with each job's metadata, `job_records`
with everything a job produces (settings used, plan, practice run, narration, captions,
reports, quality checks, log, thumbnail), and `plans` with the saved click-plans. Jobs work
in `engine/data/work/<job>/`, deleted on success and kept on failure for troubleshooting.

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
