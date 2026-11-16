# Getting started

## Requirements

- Node.js 22+ and npm 11+
- FFmpeg and ffprobe on `PATH`
- An Anthropic or OpenAI API key. That is all.
  - The voice-over is free and runs on your computer ([Kokoro](https://huggingface.co/hexgrad/Kokoro-82M),
    via `kokoro-js`). The first run downloads the voice model (~90 MB) once. English only.
  - Paid voices are optional (`voice: openai` or `voice: elevenlabs`); `voice: none` makes
    captions-only videos.

## Install

```bash
npm install
npm run browsers:install       # Playwright Chromium
cp .env.example .env           # then add your AI key
```

Run it with `npx demoforge`. For a global `demoforge` command: `cd engine/cli && npm link`.

## Where things are

| Folder | What it is |
| --- | --- |
| `products/` | **Yours.** One file per product, e.g. `products/acme.md`; the format is in the README's "Product files" |
| `output/` | **Yours.** Finished videos and reports |
| `.env` | **Yours.** Your AI key, and any password a product file reads with `env:NAME` |
| `docs/` | These guides |
| `engine/` | DemoForge itself; no need to touch it |

## Try the practice app

```bash
npm run example-app            # terminal 1: a tiny app at http://localhost:4310
npx demoforge check example    # terminal 2
npx demoforge example
```

`products/example.md` describes it: its address, its login and its release notes.

## Your own product

```bash
npx demoforge new acme         # creates products/acme.md and asks for the app's address
```

Open `products/acme.md`, add the login if the app has one, describe the app in a few
sentences, and paste your release notes. Then:

```bash
npx demoforge check acme                    # settings, keys, login, the app, local tools
npx demoforge acme                          # one video of everything new in the release notes
npx demoforge acme --each                   # one video per new feature
npx demoforge acme "show how to export"     # a video of anything else, in plain words
```

What happens:

1. The AI reads the release notes and picks the new features a viewer can see. Bug fixes,
   internal changes and headings like "Added"/"Fixed" are skipped. Both lists are printed.
2. DemoForge logs in. For each feature, the AI works out the clicks in the real app and
   proves the feature works.
3. The narration is written and spoken, the app is recorded at presentation speed in
   time with it, and the video is rendered and checked.

The working click-plan is saved in `output/.plans/`. The next video of the same feature
replays it: no AI planning, same video. Editing the feature in the release notes, or the
app changing so the plan no longer works, makes DemoForge plan again by itself. Use
`--fresh` to force it.

## Commands

| Command | Purpose |
| --- | --- |
| `npx demoforge <product> [goal]` | make videos (options: `--each`, `--fresh`, `--headed`) |
| `npx demoforge new <name>` | create `products/<name>.md` |
| `npx demoforge check <product>` | check settings, keys, login, the app and local tools |
| `npx demoforge list` | list your products |
| `npx demoforge history [product]` | recent videos |

`--headed` shows the browser while it works. `--log-level` sets how much is printed.

## What a video job writes

Each video gets a folder `output/<product>/<date-time>-<name>/`:

| Path | What |
| --- | --- |
| `video/final.mp4`, `video/thumbnail.png` | the video |
| `metadata.json` | status, AI provider and model, tokens and cost estimate, errors |
| `quality.json` | workflow, recording, audio and video checks |
| `plan.json`, `plan.yaml` | the click-plan that was recorded |
| `recording/raw.mp4`, `recording/screenshots/` | the raw take, failure screenshots |
| `narration/` | script, per-line audio clips, `audio.mp3` |
| `captions/subtitles.srt`, `.vtt` | subtitles |
| `logs/` | `execution.json`, `browser.json`, `errors.json`, `rehearsal.json`, `run.log`, `trace.zip` |

Open a trace with `npx playwright show-trace output/.../logs/trace.zip`.

## Environment variables

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude |
| `OPENAI_API_KEY` | OpenAI models, and the optional OpenAI voice |
| `ELEVENLABS_API_KEY` | optional; ElevenLabs voice |
| `DEMOFORGE_AI_PROVIDER`, `DEMOFORGE_AI_MODEL`, `DEMOFORGE_TTS_PROVIDER` | override the product file's `ai`, `model` and `voice` |
| `DEMOFORGE_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, `silent` |
| anything a product file names, e.g. `ACME_PASSWORD` | `login: demo@acme.com / env:ACME_PASSWORD` |

All of them go in the root `.env`, which git ignores.

## Tests

```bash
npm test                  # unit (fast, no browser)
npm run test:integration  # real Chromium, login, recorder and Remotion; fake AI and voice
npm run test:e2e          # real APIs (costs money); skipped when keys are missing
npm run typecheck
```
