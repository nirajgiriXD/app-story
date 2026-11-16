# Getting started

## Requirements

- Node.js 22+ and npm 11+
- FFmpeg and ffprobe on `PATH`
- An Anthropic or OpenAI API key. That is all.
  - The voice-over is free and runs on your computer ([Kokoro](https://huggingface.co/hexgrad/Kokoro-82M),
    via `kokoro-js`). The first run downloads the voice model (~90 MB) once. English only.
  - Paid voices are optional: `providers.tts.provider: openai` or `elevenlabs`.
  - `providers.tts.provider: none` makes captions-only videos.

## Install

```bash
npm install
npm run browsers:install       # Playwright Chromium
cp .env.example .env           # then fill in your keys
```

Run the CLI with `npx demoforge <command>`. To get a global `demoforge` command:
`cd engine/cli && npm link`.

## Where things are

| Folder | What it is |
| --- | --- |
| `products/` | **Yours.** One folder per product; every option explained in `products/README.md` |
| `output/` | **Yours.** Finished videos and reports |
| `.env` | **Yours.** API keys. Each product's login goes in `products/<id>/.env` |
| `docs/` | These guides |
| `engine/` | DemoForge itself; no need to touch it |

## Try the example product

The repo ships a tiny app with synthetic data (`engine/example-app`) and a product
configuration for it (`products/example`).

```bash
cp products/example/.env.example products/example/.env   # the practice app's login
npm run example-app                               # terminal 1: http://localhost:4310
npx demoforge validate --product example          # terminal 2
npx demoforge generate --product example --features
npx demoforge run --product example --scenario create-project --dry-run
npx demoforge generate --product example --objective "Demonstrate how to create a new project"
npx demoforge generate --product example --objective "..." --ai-provider openai
npx demoforge generate --product example --scenario create-project
```

Each job writes to `output/<product>/<demo>/<job-id>/`:

| Path | What |
| --- | --- |
| `video/final.mp4`, `video/thumbnail.png` | the rendered demo |
| `metadata.json` | status, providers, models, tokens and cost estimate, errors |
| `quality.json` | workflow, recording, audio and video checks |
| `plan.json`, `scenario.yaml` | the verified workflow (AI-planned runs: an unapproved scenario draft) |
| `recording/raw.mp4`, `recording/screenshots/` | the raw take, failure screenshots |
| `narration/` | script, per-line audio clips, `audio.mp3` |
| `captions/subtitles.srt`, `.vtt` | subtitles |
| `logs/` | `execution.json`, `browser.json`, `errors.json`, `rehearsal.json`, `run.log`, `trace.zip` |

Open a trace with `npx playwright show-trace output/.../logs/trace.zip`.

## Add your own product

```bash
npx demoforge init                                 # creates products/<id>/
npx demoforge browser inspect --product <id> --save-auth   # if the app needs a login
npx demoforge validate --product <id>
npx demoforge discover --product <id>              # optional: read-only exploration, demo ideas
```

Then describe the product in `instructions.md` and `knowledge/*.md`. See
[products/README.md](../products/README.md) for every option of `product.yaml` and scenarios.

## From release notes to a video

Paste your release notes into `products/<id>/features.md`, as they are: a changelog,
a bullet list, any format. You never write steps.

```bash
npx demoforge generate --product <id> --features                  # one video, all features
npx demoforge generate --product <id> --features --each           # one video per feature
npx demoforge generate --product <id> --features path/to/CHANGELOG.md
```

1. The AI reads the notes and picks the features a viewer can see in the app. Bug fixes,
   internal changes and headings like "Added"/"Fixed" are skipped. It prints both lists.
2. For each feature, it finds the clicks in the real app and verifies the feature works.
3. It writes the narration, records and renders the video.

Add `--save-scenario` to keep each verified plan for review. More in
[products/README.md](../products/README.md#featuresmd).

## From objective to repeatable scenario

1. `generate --objective "..." --save-scenario` plans and records a demo, and saves the
   verified plan to `products/<id>/scenarios/` with `approved: false`.
2. Review the steps (and optionally add `narration:` lines), then set `approved: true`.
3. `generate --scenario <id>` (or `--all`) replays it deterministically, without AI planning.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | create a product folder |
| `products list` / `products inspect <id>` | see configured products and scenarios |
| `validate --product <id>` | config, scenarios, credentials, FFmpeg, Chromium |
| `discover --product <id>` | read-only exploration and demo suggestions |
| `generate --product <id> --features/--objective/--scenario/--all` | make videos |
| `run --product <id> --scenario/--objective --dry-run` | run in the browser, no video |
| `browser inspect --product <id> [--save-auth]` | open the app in a visible browser |
| `history` | recent jobs |

Global flag: `--log-level`. Provider flags on `generate`, `run` and `discover`:
`--ai-provider`, `--ai-model`, `--tts-provider`.

Products always live in `products/` and jobs in `output/`, both at the top of the
repository, wherever you run the command from. The root `.env` is read from there too.

## Environment variables

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude |
| `OPENAI_API_KEY` | OpenAI models, and the optional OpenAI voice |
| `ELEVENLABS_API_KEY` | optional; ElevenLabs text-to-speech |
| `DEMOFORGE_AI_PROVIDER`, `DEMOFORGE_AI_MODEL`, `DEMOFORGE_TTS_PROVIDER` | override product.yaml (CLI flags win) |
| `DEMOFORGE_LOG_LEVEL` | `debug`, `info`, `warn`, ... |
| product-specific, e.g. `EXAMPLE_APP_USER` | login credentials named in product.yaml; put them in `products/<id>/.env` |

Keys shared by every product go in the root `.env`. Values for one product (its login)
go in that product's own `products/<id>/.env`; a value set in the shell or the root
`.env` wins over it. Both files are ignored by git.

## Tests

```bash
npm test                  # unit (fast, no browser)
npm run test:integration  # real Chromium, recorder and Remotion; fake AI and voice
npm run test:e2e          # real APIs (costs money); skipped when keys are missing
npm run typecheck
```
