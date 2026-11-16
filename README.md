# AppStory

[![CI](https://github.com/nirajgiriXD/app-story/actions/workflows/ci.yml/badge.svg)](https://github.com/nirajgiriXD/app-story/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> An AI-powered platform for automatically exploring web applications, demonstrating product features, and generating professional product demo videos.

AppStory uses AI agents powered by **Anthropic Claude or OpenAI**, **Playwright for real browser interaction**, and a video-rendering pipeline to turn product workflows into polished demonstration videos.

The goal is to make product demo creation repeatable and largely automated. Instead of manually recording every feature, users provide a web application, define what they want to demonstrate, and let AppStory plan, execute, record, narrate, and render the demo.

## Where things are

```text
app-story/
├── products/     👉 your products: one file each, e.g. products/acme.md (see "Product files")
├── output/       👉 finished videos, nothing else (see "Output")
├── .env          👉 your AI key, voice choices, and passwords read with env:NAME
├── docs/         guides: start with docs/getting-started.md
└── engine/       AppStory itself — no need to touch it to make videos (see "Engine")
```

Quick start: `npm install`, `npm run browsers:install`, add a key to `.env`, then
`npx app-story new acme`, fill in `products/acme.md`, and `npx app-story acme`.
See [docs/getting-started.md](docs/getting-started.md).

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
ai: anthropic                              # anthropic | openai (default: whichever key you have)
model: claude-opus-5-5                     # default: the provider's default model
voice: kokoro                              # kokoro (free) | openai | elevenlabs | none
length: 60                                 # longest video, in seconds (default: 90)
template: product-update                   # the video's look (default: picked per video, see below)
language: en                               # Kokoro speaks English only
logo: acme-logo.png                        # next to this file
color: "#4F46E5"                           # in quotes
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
- **template**: the video's look. Only the look changes; clicks, narration and length do not.

  | Template | Look | Picked by itself for |
  | --- | --- | --- |
  | `product-update` | app in a browser window, dark background, "New" badge on the title | `npx app-story acme` (what's new) |
  | `feature-highlight` | browser window, strongest zoom, biggest title | `npx app-story acme --each` (one feature per video) |
  | `tutorial` | full screen, light, big cursor, close zoom | `npx app-story acme "show how to …"` (a how-to) |
  | `modern-saas` | browser window, colorful background, medium zoom | — |
  | `minimal` | full screen, plain light, gentle zoom, no chapter labels | — |

  Set `template:` to use one look for every video of the product.

Files whose name starts with `_` (for example `_draft.md`) are not treated as products.

### What AppStory handles by itself

- Picks the features from the release notes.
- Logs in, plans the clicks in the real app, proves each feature works, then records it.
- Saves each working plan in its database and replays it next time: no AI cost, same
  video. If you edit the feature in the release notes, or the app changed and the plan
  stops working, it plans again. Use `--fresh` to force a new plan.
- Reuses what has not changed: the feature list of an unchanged product file, the
  narration of a replayed plan, and every line already spoken in the same voice.
- Fits the narration to the clicks: each line is about as long as its steps take on
  screen, so the video never stands still waiting for the voice. `length` is the
  longest a video may be; a short flow makes a short video.

## Voice

The voice is set in `.env` and applies to every product. All of it is optional.

```bash
APP_STORY_VOICE=female            # female | male | a voice name (default: female)
APP_STORY_VOICE_ACCENT=american   # american | british (default: american)
APP_STORY_VOICE_SPEED=1.0         # 0.7 (slower) to 1.3 (faster)
APP_STORY_VOICE_TONE=             # e.g. "warm and upbeat" (OpenAI voice only)
```

- **Kokoro** (the free default) picks its best voice for the gender and accent:
  female American *Heart*, male American *Michael*, female British *Emma*, male British
  *George*. You can also name any Kokoro voice, e.g. `APP_STORY_VOICE=am_puck`; the 28
  names are listed by `npx app-story check <product>` when a name is wrong. Kokoro has no
  tone, emotion or pitch control.
- **OpenAI** (`voice: openai` in the product file) needs a voice name, e.g. `marin`,
  `cedar`, `coral` or `onyx`, and is the one that follows `APP_STORY_VOICE_TONE`.
- **ElevenLabs** (`voice: elevenlabs`) needs a voice id from your ElevenLabs account.

## Output

`output/` holds only the finished videos:

```text
output/
└── acme/
    ├── 20261116-134205-a1b2c3-whats-new-2-4.mp4
    └── 20261116-141010-d4e5f6-bulk-export.mp4
```

Everything else is kept in one SQLite database, `engine/data/app-story.db` (ignored by
git):

| Table | What it keeps |
| --- | --- |
| `jobs` | one row per video: product, goal, status, AI and model, voice, cost, video path, full metadata |
| `job_records` | per video: the product settings used (passwords hidden), the click-plan, the AI's practice run, narration script, captions (SRT and WebVTT), recording and browser reports, quality checks, the log, and the thumbnail |
| `plans` | the working click-plan of each feature, replayed by the next video without AI planning |
| `cache` | AI answers and spoken lines that are identical for identical inputs (unused entries are deleted after 30 days) |

While a video is being made, its raw recording and voice clips sit in
`engine/data/work/<job>/`. That folder is deleted when the video succeeds, and kept when it
fails so you can see what happened (the path is printed).

`npx app-story history` lists recent videos from the database. Deleting a video file is
safe; deleting `engine/data/` forgets the history and the saved plans (the next videos
are planned again).

## Engine

`engine/` is AppStory itself. You do not need to change anything there to make videos:
your work happens in `products/`, and the videos land in `output/`.

```text
engine/
├── cli/            the `app-story` command (npx app-story ...)
├── packages/       the building blocks
│   ├── core/         runs every step of a job, in order; keeps the SQLite database
│   ├── ai/           talks to Anthropic or OpenAI; plans the clicks
│   ├── browser/      drives a real Chromium browser and records the screen
│   ├── workflow/     checks and replays click-plans
│   ├── narration/    writes the script and speaks it (Kokoro, OpenAI, ElevenLabs)
│   ├── captions/     subtitles
│   ├── video/        renders the final MP4 (headless Chromium + FFmpeg)
│   ├── products/     reads the product files in products/
│   ├── contracts/    the shape of every config and result file
│   └── shared/       small helpers used everywhere
├── data/           the SQLite database and scratch folders of running jobs (git-ignored),
│                   and example-app/: a tiny fake app to practise on (npm run example-app)
├── tests/          unit, integration (real browser) and e2e (real AI) tests, fixtures
├── scripts/        helper that starts the tests
├── tsconfig*.json  TypeScript settings
└── vitest.config.ts
```

How the parts fit together: [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js 22.13 or newer
- [FFmpeg](https://ffmpeg.org) (`ffmpeg` and `ffprobe` on your PATH)
- An Anthropic or OpenAI API key in `.env`
- Chromium for Playwright: `npm run browsers:install`

## Development

```bash
npm run typecheck      # TypeScript
npm run lint           # Biome: lint and formatting checks
npm run format         # Biome: format every file
npm test               # unit tests
npm run test:all       # unit, integration (real browser) and e2e (real AI, needs a key)
```

GitHub Actions runs the checks and tests on every push to `main` and every pull request.

- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md)
- The original design brief: [docs/design.md](docs/design.md)

## Security

AppStory logs in to real apps and uses your AI keys. Please report security problems
privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
