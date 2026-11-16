# Getting started

## Requirements

- With Docker, nothing else. Without Docker: Node.js 22.13+ (for its built-in SQLite),
  and FFmpeg and ffprobe on `PATH`.
- An Anthropic or OpenAI API key. That is all.
  - The voice-over is free and runs on your computer ([Kokoro](https://huggingface.co/hexgrad/Kokoro-82M),
    via `kokoro-js`). The first run downloads the voice model (~90 MB) once. English only.
  - Paid voices are optional (`voice: openai` or `voice: elevenlabs`); `voice: none` makes
    captions-only videos. Female or male, accent, speed and tone are set in `.env`
    (see "Voice" in the README).

## Install

In your project, with npm:

```bash
npm install --save-dev app-story
npx playwright install chromium   # the browser it drives
```

Or with Docker, from your project folder (Linux: add `--user "$(id -u):$(id -g)"`):

```bash
docker run --rm -it -v "$PWD:/work" ghcr.io/nirajgirixd/app-story check acme
```

In the commands below, `npx app-story` then becomes
`docker run --rm -it -v "$PWD:/work" ghcr.io/nirajgirixd/app-story`. An app on your own
computer is at `http://host.docker.internal:<port>` from inside Docker.

Or from this repository, to work on AppStory itself:

```bash
npm install
npm run browsers:install       # Playwright Chromium
```

Then put your AI key in `.env` (copy `.env.example` from this repository for the full list).

## Where things are

Everything lives in your project folder: the nearest folder, from where you run AppStory
upwards, with a `products/` or `.app-story/` folder (`APP_STORY_HOME` picks it explicitly).

| Folder | What it is |
| --- | --- |
| `products/` | **Yours.** One file per product, e.g. `products/acme.md`; the format is in the README's "Product files" |
| `products/acme.plans/` | **Yours.** The saved click-plans of acme, one YAML file per video. Commit them |
| `output/` | **Yours.** Finished videos, nothing else |
| `.env` | **Yours.** Your AI key, and any password a product file reads with `env:NAME` |
| `.app-story/` | AppStory's records: database, kept recordings, scratch folders. Git ignores it by itself |

## Try the practice app

```bash
npm run example-app            # terminal 1: a tiny app at http://localhost:4310
npx app-story check example    # terminal 2
npx app-story example
```

`products/example.md` describes it: its address, its login and its release notes.

## Your own product

```bash
npx app-story new acme         # creates products/acme.md and asks for the app's address
```

Open `products/acme.md`, add the login if the app has one, describe the app in a few
sentences, and paste your release notes. Then:

```bash
npx app-story check acme                    # settings, keys, login, the app, local tools
npx app-story acme                          # one video of everything new in the release notes
npx app-story acme --each                   # one video per new feature
npx app-story acme "show how to export"     # a video of anything else, in plain words
```

What happens:

1. The AI reads the release notes and picks the new features a viewer can see. Bug fixes,
   internal changes and headings like "Added"/"Fixed" are skipped. Both lists are printed.
2. AppStory logs in. For each feature, the AI works out the clicks in the real app and
   proves the feature works.
3. The narration is written and spoken, the app is recorded at presentation speed in
   time with it, and the video is rendered and checked.

The working click-plan is saved as a file, `products/acme.plans/<video>.yaml`. The next
video of the same feature replays it: no AI planning, same video. Commit the file and
your teammates and automated runs replay the same clicks. Editing the feature in the
release notes, or the app changing so the plan no longer works, makes AppStory plan again
by itself and replace the file. Use `--fresh` to force it, or delete the file.

The recording of the 5 newest videos of each product is kept. To make one again with
another look, or after changing the logo, color, music or captions in the product file:

```bash
npx app-story redo acme                          # the newest acme video, with the current settings
npx app-story redo acme --template tutorial      # in another look
npx app-story redo acme 20261116-134205-a1b2c3   # an older one (ids are in `history`)
```

A redo opens no browser and calls no AI, so it works even when the app is down. The
clicks, the voice and the timing stay as recorded.

## Commands

| Command | Purpose |
| --- | --- |
| `npx app-story <product> [goal]` | make videos (options: `--each`, `--fresh`, `--headed`) |
| `npx app-story new <name>` | create `products/<name>.md` |
| `npx app-story check <product>` | check settings, keys, login, the app and local tools |
| `npx app-story list` | list your products |
| `npx app-story history [product]` | recent videos, with their ids |
| `npx app-story redo <product> [video]` | make a video again from its kept recording (option: `--template`) |

`--headed` shows the browser while it works. `--log-level` sets how much is printed.

## What a video job keeps

Only the video goes to `output/<product>/<job-id>-<name>.mp4`. Everything else is in the
SQLite database `.app-story/app-story.db` (see "Output" in the README):

| Record | What |
| --- | --- |
| `jobs` row | status, goal, AI provider and model, voice, tokens and cost estimate, errors, video path |
| `config` | the product settings used (a password written in the file is hidden) |
| `plan`, `rehearsal` | the click-plan that was recorded, and the AI's practice run |
| `narration_script`, `narration_clips` | what the narrator says, line by line |
| `captions_srt`, `captions_vtt` | subtitles |
| `execution`, `browser_issues`, `quality` | step results, console/network problems, quality checks |
| `log`, `thumbnail` | the full log, and a PNG cover image |

A failed video keeps its scratch folder, `.app-story/work/<job>/`, with the raw recording,
failure screenshots and `logs/trace.zip` (open it with `npx playwright show-trace`).

Any SQLite tool can read the database, for example:

```bash
sqlite3 .app-story/app-story.db "SELECT created_at, product_id, status, video_path FROM jobs ORDER BY created_at DESC"
```

## Environment variables

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude |
| `OPENAI_API_KEY` | OpenAI models, and the optional OpenAI voice |
| `ELEVENLABS_API_KEY` | optional; ElevenLabs voice |
| `APP_STORY_VOICE`, `APP_STORY_VOICE_ACCENT`, `APP_STORY_VOICE_SPEED`, `APP_STORY_VOICE_TONE` | which voice speaks (female, male or a name), accent, speed and tone |
| `APP_STORY_AI_PROVIDER`, `APP_STORY_AI_MODEL`, `APP_STORY_TTS_PROVIDER` | override the product file's `ai`, `model` and `voice` |
| `APP_STORY_AI_EFFORT` | `low` to `max`: how hard the AI thinks in every step (default: `high` for planning, `low` for the script) |
| `APP_STORY_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, `silent` |
| `APP_STORY_HOME` | your project folder, when it is not found by itself |
| `APP_STORY_RENDER_WORKERS` | how many frames are drawn at once while rendering (default: one per two CPU cores, up to 8) |
| anything a product file names, e.g. `ACME_PASSWORD` | `login: demo@acme.com / env:ACME_PASSWORD` |

All of them go in your project's `.env` (`APP_STORY_HOME` must be set outside it). Keep
`.env` out of git.

## Tests

```bash
npm test                  # unit (fast, no browser)
npm run test:integration  # real Chromium, login, recorder and renderer; fake AI and voice
npm run test:e2e          # the full flow with recorded AI answers (free); see CONTRIBUTING.md to record them
npm run typecheck
```
