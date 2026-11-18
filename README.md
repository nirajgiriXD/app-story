# AppStory

[![CI](https://github.com/nirajgiriXD/app-story/actions/workflows/ci.yml/badge.svg)](https://github.com/nirajgiriXD/app-story/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> An AI-powered platform for automatically exploring web applications, demonstrating product features, and generating professional product demo videos.

AppStory uses AI agents powered by **Anthropic Claude or OpenAI**, **Playwright for real browser interaction**, and a video-rendering pipeline to turn product workflows into polished demonstration videos.

The goal is to make product demo creation repeatable and largely automated. Instead of manually recording every feature, users provide a web application, define what they want to demonstrate, and let AppStory plan, execute, record, narrate, and render the demo.

## Install

Pick one. They all make the same videos.

**In your project, with npm.** Needs Node.js 22.13+ and [FFmpeg](https://ffmpeg.org).

```bash
npm install --save-dev app-story
npx playwright install chromium   # the browser it drives
npx app-story new acme            # creates products/acme.md
```

**With Docker.** Needs only Docker: Node, Chromium, FFmpeg and the voice model are inside.

```bash
docker pull ghcr.io/nirajgirixd/app-story
docker run --rm -it -v "$PWD:/work" ghcr.io/nirajgirixd/app-story new acme
```

Run it from your project folder; it reads `.env` and `products/` there and writes the
videos to `output/`. On Linux, add `--user "$(id -u):$(id -g)"` so the files are yours.
Inside Docker, an app running on your own computer is at `host.docker.internal`, not
`localhost`. To build the image yourself: `docker build -t app-story .` in this repository.

**From this repository**, to work on AppStory itself: see [CONTRIBUTING.md](CONTRIBUTING.md).

Then add your AI key to `.env` (`ANTHROPIC_API_KEY=...` or `OPENAI_API_KEY=...`), fill in
`products/acme.md`, and run `npx app-story acme`. See [docs/getting-started.md](docs/getting-started.md).

## Where things are

AppStory works in your project folder:

```text
your-project/
├── products/          👉 your products: one file each, e.g. products/acme.md (see "Product files")
│   └── acme.plans/    the saved click-plans of acme, one YAML file per video: commit them
├── output/            👉 finished videos and their captions (see "Output")
├── .env               👉 your AI key, voice choices, and passwords read with env:NAME
└── .app-story/        AppStory's records: history, cache and kept recordings (git ignores it by itself)
```

Your project folder is the nearest folder, from where you run AppStory upwards, that has a
`products/` or `.app-story/` folder (or the current folder, the first time).
`APP_STORY_HOME=/some/folder` picks it explicitly. In this repository it is the repository
itself, so `products/example.md` is ready to try.

## Product files

Each product is a single Markdown file: `products/<name>.md`. That is all AppStory
needs. It never needs your product's source code: it opens the running app in a browser.

```bash
npx app-story new acme          # creates products/acme.md
npx app-story check acme        # checks it
npx app-story acme              # one video of what's new in its release notes
```

`products/example.md` is a working product for the practice app (`npm run example-app`).

### What goes in the file

A small settings block at the top, read by AppStory and **never sent to the AI**. Then
plain English for the AI: what the app is, tips, and your release notes, as they are.

```markdown
---
url: https://staging.acme.com
login: demo@acme.com / env:ACME_PASSWORD
---

# Acme

Acme is a billing tool for small shops. Most users are shop owners
who are not technical. Videos should be friendly and short.

## Tips for the demo
- The app opens on the Dashboard. Use the left menu to move around.
- Use made-up customers like "Bob's Bakery". Never use real names.
- Invoices live under Billing → Invoices.

## Release notes
### Added
- Bulk export: export many invoices at once as CSV (Reports page).
- Dark mode for the whole app.
### Fixed
- Crash when saving an empty report.
```

The headings are only a suggestion: the AI reads all of it. From the release notes it
picks the new features a viewer can see and skips fixes and internal changes. You
never write click-by-click steps. Text inside `<!-- -->` is ignored.

**Form data.** When the demo fills a form, the AI uses any values your file gives for it
(for example "use the customer Bob's Bakery"). Otherwise it reads what the product and the
form are for, and types believable values that fit. Credentials that a feature needs
(a test card, an API key, a second account) are used **only** if your file gives them;
the AI never makes them up. Write secret ones as `{{env:NAME}}`, e.g.
"Test card: `{{env:ACME_TEST_CARD}}`", so the value comes from `.env` and is hidden in logs.
The app's own login is the `login:` setting, which AppStory handles before the AI starts.

### Settings

Only `url` is required. Everything else has a sensible default.

```markdown
---
url: https://staging.acme.com              # required: the running app (and the page to start on)
login: demo@acme.com / env:ACME_PASSWORD   # user / password; either part may be env:NAME
login page: /login                         # default: found automatically
start page: /dashboard                     # default: the page in url
reset: npm run db:seed                     # puts the demo data back before each run (or an https:// address to POST)
website: https://acme.com                  # the public address viewers see (default: the url's)
cta: "Start your free trial at {host}"     # the end card's words; {host} is the website
ai: anthropic                              # anthropic | openai | local (default: whichever key you have)
model: claude-opus-5-5                     # default: the provider's default model
voice: kokoro                              # kokoro (free) | chatterbox (free, needs Python) | openai | elevenlabs | none
length: 60                                 # longest video, in seconds (default: 90)
template: product-update                   # the video's look (default: picked per video, see below)
tone: energetic                            # calm (default) | friendly | energetic: how the script and voice sound
fps: 60                                    # 60 (smooth, default) | 30 (renders in half the time)
resolution: 1080p                          # 1080p (default) | 1440p | 4k: sharper text, slower render
language: en                               # or several: en, de, fr (one video each; needs the openai or elevenlabs voice)
formats: vertical, gif                     # also make a 9:16 and/or 1:1 (square) version, and a GIF
blur: ".api-key, #customer-email"          # CSS selectors blurred on screen (quote them when one starts with #)
logo: acme-logo.png                        # next to this file
color: "#4F46E5"                           # in quotes
font: acme-sans.woff2                      # a font file next to this file, or a font name (default: Inter)
background: brand-backdrop.jpg             # behind the cards and the app: an image next to this file, or "#0B1020"
music: calm-track.mp3                      # background music, next to this file (default: none)
music volume: 0.08                         # 0 to 1; it dips under the voice by itself
allow: delete, emails                      # risky actions are blocked unless listed here
---
```

- **login**: `env:ACME_PASSWORD` reads the password from `.env`, so it never sits in a
  file you might share. Writing the password directly works too. AppStory finds the
  login form on its own; if it cannot, add `login page:`. Logins with two steps (email
  first, password on the next page) and single sign-on are not supported yet.
- **allow**: by default AppStory never deletes, pays, sends emails, publishes, changes
  account settings or invites users. List any of `delete, payments, emails, publishing,
  account settings, invite users, production data` to allow them.
- **ai**: with keys for both providers, the other one is used as a backup if the first fails.
  `ai: local` uses any server with the OpenAI Chat Completions API, such as Ollama, LM
  Studio or vLLM, so open-weight models work with no paid key: set
  `APP_STORY_AI_BASE_URL` in `.env` (e.g. `http://localhost:11434/v1`) and `model:` to a
  model it has. Planning the clicks is the hardest job, so pick a strong model with tool
  calling; once a plan is saved, its videos need no AI at all.
- **language**: the first language paces the recording. Each other one is translated by
  the AI, voiced, captioned and rendered over the *same* recording: `…-name.de.mp4` and
  `…-name.de.srt` next to the main video. Kokoro speaks English only. Chatterbox, also
  free and local, speaks 23 languages (ar, da, de, el, en, es, fi, fr, he, hi, it, ja, ko,
  ms, nl, no, pl, pt, ru, sv, sw, tr, zh); `voice: openai` and `voice: elevenlabs` speak more.
- **formats**: `vertical` (9:16, for Reels, Shorts and TikTok), `square` (1:1) and `gif`
  (the app part, silent, sped up to at most 30 seconds, for a README). Made for the first language.
- **blur**: anything matching these CSS selectors is blurred in the page itself, so the
  recording, screenshots and video never show it readable: API keys, customer emails.
  YAML reads ` #` as a comment, so put the selectors in quotes when one starts with `#`.
- **reset**: the AI's practice run really clicks through your app, so the project or
  invoice it creates exists before the recording makes it again: the list shows it twice,
  or the app says the name is taken. `reset:` puts the demo data back before the practice
  run, before every recording and before every `test`. A command runs in your project
  folder and must exit with 0; an `https://` address is sent a POST and must answer 2xx.
  `{{env:NAME}}` reads a token from `.env`.
- **website**: demos usually run on a staging or local copy of the app. The video's browser
  bar shows the app's pages under this address instead, and the end card and the voice
  send viewers there, so a video never shows `staging.acme.com` or `localhost:3000`.
- **font**: the titles, captions and end card use Inter, which ships with AppStory, so a
  video looks the same on every computer. A font file (`.woff2`, `.woff`, `.ttf`, `.otf`)
  is loaded the same way; a plain name uses that font only if the computer has it.
- **background**: replaces the template's backdrop with your brand's. A colour (in quotes)
  sets light or dark words by itself; an image is dimmed a little so white words read on
  it, so pick a calm one (a soft gradient, a blurred photo) over a busy pattern.
- **music**: an audio file (MP3, WAV, M4A…) looped under the whole video, faded in and out,
  and lowered while the voice speaks. Use music you are allowed to publish: tracks marked
  CC0 (public domain) need no credit.
- **tone**: `calm` suits tutorials, `friendly` product updates, and `energetic` launch and
  marketing videos: a hook first, short punchy lines, a clear call to try it. Every tone only
  claims what the recording shows. The OpenAI and Chatterbox voices deliver it too, unless
  `APP_STORY_VOICE_TONE` says otherwise.
- **template**: the video's look. Only the look changes; clicks, narration and length do not.

  | Template | Look | Picked by itself for |
  | --- | --- | --- |
  | `product-update` | app in a browser window, dark background, "New" badge on the title | `npx app-story acme` (what's new) |
  | `feature-highlight` | browser window, strongest zoom, biggest title | `npx app-story acme --each` (one feature per video) |
  | `tutorial` | full screen, light, big cursor, close zoom | `npx app-story acme "show how to …"` (a how-to) |
  | `modern-saas` | browser window, colorful background, medium zoom | — |
  | `minimal` | full screen, plain light, gentle zoom, no chapter labels | — |

  Set `template:` to use one look for every video of the product.

Files whose name starts with `_` or `.` (for example `_draft.md`), and a `README.md`, are
not treated as products. Product names are lowercase letters, numbers and dashes.

### What AppStory handles by itself

- Picks the features from the release notes.
- Logs in, plans the clicks in the real app, proves each feature works, then records it.
- Saves each working plan as a file next to the product file
  (`products/acme.plans/<video>.yaml`) and replays it next time: no AI cost, same video.
  Commit these files, so teammates and automated runs replay the same clicks, and
  changes to a plan show up in pull requests. If you edit the feature in the release
  notes, or the app changed and the plan stops working, it plans again and replaces the
  file. Use `--fresh` to force a new plan, or delete the file.
- Keeps the recording of the 5 newest videos of each product, so a video can be made
  again in another look, or with a new `logo` or `color`, without the app and without
  AI: `npx app-story redo acme --template tutorial`. The clicks, the voice and the timing
  stay as recorded.
- Finishes a failed video without planning it again: `npx app-story resume acme`
  replays the plan the AI already made (or renders the kept recording again, if the
  render failed), so a failure late in the run does not cost a second AI planning pass.
- Reuses what has not changed: the feature list of an unchanged product file, the
  narration of a replayed plan, and every line already spoken in the same voice.
- Fits the narration to the clicks: each line is about as long as its steps take on
  screen, so the video never stands still waiting for the voice. `length` is the
  longest a video may be; a short flow makes a short video. When a line covers several
  steps, a click lands on the word that names it ("…then **save** it").
- Saves the narration (and every translation) in the plan file, so the next video of the
  plan, on any machine, needs no AI at all.
- Shows keys pressed on camera as keycaps (`Ctrl` `K`), and tells the AI up front which
  buttons the safety rules block, so it does not waste a turn trying them.

## Plans as tests, CI and Playwright

A saved plan is a proven path through your app, so it can do more than make a video.

```bash
npx app-story test acme                    # does every saved plan still work? (fast: no video, no AI)
npx app-story replay acme                  # make every saved plan's video again, with no AI
npx app-story import acme trace.zip        # a Playwright test becomes a plan
```

- **test** replays each plan at full speed and checks every expected outcome. When the
  app changes under a demo, it names the step that broke, with a screenshot, before the
  video goes stale. It exits with 1 when a plan fails, so CI can stop on it.
- **replay** makes the videos again exactly as planned, with the narration saved in each
  plan: the same video every time, no AI key needed. A plan that no longer works fails
  instead of being planned again.
- **import** reads a trace from `npx playwright test --trace on` (in `test-results/`): its
  clicks, typing and `expect()` checks become a plan. The test's own login is left out
  (AppStory logs in with `login:`) and passwords are never copied. Run `replay` once with
  an AI key to write its narration, then commit the plan.

In GitHub Actions, the action in this repository runs the Docker image for you:

```yaml
- uses: nirajgiriXD/app-story@main
  with:
    products: acme
    command: replay          # or: test
    version: 0.1.0           # the AppStory version to run
    env-vars: ACME_PASSWORD  # passwords your product files read with env:NAME
  env:
    ACME_PASSWORD: ${{ secrets.ACME_PASSWORD }}
```

The videos are uploaded as a workflow artifact. Your app must be running on the runner
(start it in an earlier step); the container shares the runner's network, so
`localhost` works. A full example is in [docs/ci.md](docs/ci.md).

## Voice

The voice is set in `.env` and applies to every product. All of it is optional.

```bash
APP_STORY_VOICE=female            # female | male | a voice name (default: female)
APP_STORY_VOICE_ACCENT=american   # american | british (default: american)
APP_STORY_VOICE_SPEED=1.0         # 0.7 (slower) to 1.3 (faster)
APP_STORY_VOICE_TONE=             # e.g. "warm and upbeat" (OpenAI voice; Chatterbox: "expressive")
```

- **Kokoro** (the free default) picks its best voice for the gender and accent:
  female American *Heart*, male American *Michael*, female British *Emma*, male British
  *George*. You can also name any Kokoro voice, e.g. `APP_STORY_VOICE=am_puck`; the 28
  names are listed by `npx app-story check <product>` when a name is wrong. Kokoro has no
  tone, emotion or pitch control.
- **OpenAI** (`voice: openai` in the product file) needs a voice name, e.g. `marin`,
  `cedar`, `coral` or `onyx`, and is the one that follows `APP_STORY_VOICE_TONE`.
- **ElevenLabs** (`voice: elevenlabs`) needs a voice id from your ElevenLabs account.
- **Chatterbox** (`voice: chatterbox`) is free and local like Kokoro, sounds more natural,
  and can copy a voice: set `APP_STORY_VOICE` to a 10-20 second WAV of the voice you want
  (yours, for example). It runs in Python: `pip install chatterbox-tts` (a GPU helps but is
  not needed), and `APP_STORY_PYTHON` names that Python if it is not the one on PATH. The
  first video downloads its model (about 2 GB) once, which takes a while; the first video in
  another language downloads Chatterbox Multilingual the same way.
  `APP_STORY_VOICE_TONE=expressive` gives a livelier delivery.

## Output

`output/` holds only what you post: each finished video with its captions (`.srt`, when
captions are on), its thumbnail (`.png`, the title card) and a description to paste
(`.description.txt`: the summary, YouTube chapters when the video has enough of them, and
the link to try it), plus any other languages and formats the product file asks for
(`….de.mp4`, `….vertical.mp4`, `….gif`). The MP4 carries its chapters too, so players list them.

Every video's first frame is its title card, so Slack, X and Discord show it as the preview.

```text
output/
└── acme/
    ├── 20261116-141010-d4e5f6-bulk-export.mp4
    ├── 20261116-141010-d4e5f6-bulk-export.srt
    ├── 20261116-141010-d4e5f6-bulk-export.png
    └── 20261116-141010-d4e5f6-bulk-export.description.txt
```

The saved plans are in `products/<product>.plans/` (see above). Everything else is in
`.app-story/`, which git ignores:

```text
.app-story/
├── app-story.db       history, records and cache (SQLite)
├── takes/<job>/       the recording, spoken clips and timeline of a recent video, for redo,
│                      and timeline.otio: the edit, to finish in DaVinci Resolve or another editor
├── render-cache/      drawn two-second chunks of recent videos: a re-render only draws what changed
├── tests/             screenshots of plans that failed `npx app-story test`
└── work/<job>/        scratch files of a video being made
```

The database has these tables:

| Table | What it keeps |
| --- | --- |
| `jobs` | one row per video: product, goal, status, AI and model, voice, cost, video path, full metadata |
| `job_records` | per video: the product settings used (passwords hidden), the click-plan, the AI's practice run, narration script, captions (SRT and WebVTT), recording and browser reports, quality checks, the AI's review of the finished video, the log, and the thumbnail |
| `cache` | AI answers and spoken lines that are identical for identical inputs (unused entries are deleted after 30 days) |

A video's scratch folder, `.app-story/work/<job>/`, is deleted when the video succeeds,
and kept when it fails so you can see what happened (the path is printed).

`npx app-story history` lists recent videos from the database, with their ids. Deleting a
video file is safe; deleting `.app-story/` forgets the history and the kept recordings,
but not the saved plans.

## The code

AppStory itself is the rest of this repository. You do not need to change anything there
to make videos: your work happens in `products/`, and the videos land in `output/`.

```text
app-story/
├── cli/            the `app-story` command (npx app-story ...)
├── packages/       the building blocks
│   ├── core/         runs every step of a job, in order; the AI's practice run that plans the clicks; the SQLite database
│   ├── ai/           talks to Anthropic or OpenAI; the prompts
│   ├── browser/      drives a real Chromium browser and records the screen
│   ├── workflow/     checks and replays click-plans
│   ├── narration/    writes the script and speaks it (Kokoro, Chatterbox, OpenAI, ElevenLabs)
│   ├── captions/     subtitles
│   ├── video/        renders the final MP4 (headless Chromium + FFmpeg)
│   ├── products/     reads the product files in products/
│   ├── contracts/    the shape of every config and result file
│   └── shared/       small helpers used everywhere
├── tests/          unit, integration (real browser) and e2e (recorded AI answers) tests, fixtures,
│                   and example-app/: the practice app they run against (npm run example-app)
├── scripts/        helpers that start the tests and build the npm package
├── tsconfig*.json  TypeScript settings
└── vitest.config.ts
```

How the parts fit together: [docs/architecture.md](docs/architecture.md).

## Requirements

- An Anthropic or OpenAI API key in `.env`, or a local AI server (`ai: local`)
- With Docker: nothing else.
- Without Docker: Node.js 22.13 or newer, [FFmpeg](https://ffmpeg.org) (`ffmpeg` and
  `ffprobe` on your PATH), and Chromium for Playwright (`npx playwright install chromium`)
- Only for the Chatterbox voice: Python with `pip install chatterbox-tts`

## Development

```bash
npm run typecheck      # TypeScript
npm run lint           # Biome: lint and formatting checks
npm run format         # Biome: format every file
npm test               # unit tests
npm run test:all       # unit, integration (real browser) and e2e (recorded AI answers)
npm run build          # the npm package, in dist/app-story/
```

GitHub Actions runs the checks and tests on every push to `main` and every pull request.

- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md)
- The original design brief: [docs/design.md](docs/design.md)

## Security

AppStory logs in to real apps and uses your AI keys. Please report security problems
privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

Everything AppStory installs, downloads or ships (packages, FFmpeg, voice and word timing
models, the Inter font) is free to use commercially; see [docs/licenses.md](docs/licenses.md).
