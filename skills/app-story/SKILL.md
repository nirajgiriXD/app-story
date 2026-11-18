---
name: app-story
description: Make a narrated product demo video of the web app in this project with AppStory, which drives a real browser through the running app, records it, narrates it and renders an MP4. Use when someone asks for a demo video, a feature video, a release video or a "what's new" video of their app, or to set up or run AppStory (apps/<name>.md, npx app-story).
---

# AppStory

AppStory makes demo videos of a running web app. It never needs the app's source code: it
opens the app in a browser, plans the clicks with an AI, proves each feature works, records
it, adds a voice and captions, and renders an MP4 that opens on the app (`--intro` adds a
full-screen intro first; `--captions` draws the captions on the video, not only in the
`.srt`; `--chapters` shows a label naming each chapter over the app; `--no-keys` hides the keycaps shown when a key is pressed). Your job is to set it up for this project and run it. The full reference is the AppStory README
(https://github.com/nirajgiriXD/app-story#readme).

## 1. Check what is there

- Is AppStory installed? Look for `app-story` in `package.json`, or run `npx app-story --help`.
  If it is missing, ask before installing it: `npm install --save-dev app-story`, then
  `npx playwright install chromium`. It needs Node.js 22.13+ and FFmpeg on `PATH`. With
  Docker instead, see the README's "Install".
- Is there a `apps/` folder? Each product is one Markdown file, `apps/<name>.md`.
  If one exists, work with it; do not make a second one for the same app.
- Is there an AI key? `.env` needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (or `ai: local`
  with a local model server). Check only that the name is set; never print or copy the value.

## 2. Ask for the running app

AppStory clicks through a running copy of the app, and really does what it clicks: it
creates records, submits forms. Ask the user which address to use: a local dev server or a
staging copy, never production unless the user says so. If it is the local dev server,
find its start command (`package.json` scripts, the README) and offer to start it.

## 3. Write the product file

Start it with `npx app-story new <name> --url <address>` (without `--url` it asks for the
address and waits), then fill it in. A small settings block, then plain
English for the AI:

```markdown
---
url: http://localhost:3000/dashboard
login: demo@example.com / env:APP_DEMO_PASSWORD
---

# <Product name>

<What the app is and who uses it, in two or three sentences, from the README.>

## Tips for the demo
- <How to move around: the menu, where the main pages are, from the routes and the nav.>
- <Made-up data to use, e.g. a customer "Bob's Bakery". Never real people.>

## Release notes
### Added
- <Each new thing a user can see, and where it is.>
```

- **Release notes**: take them from `CHANGELOG.md`, the latest release, or the commits since
  the last tag (`git log <tag>..HEAD`). Keep what a user can see in the app; drop fixes
  nobody can see, refactors and dependency bumps. Say where each feature is ("on the
  Reports page"). Never invent a feature, a number or a claim: the video says what the
  notes say.
- **Login**: write passwords as `env:NAME` and ask the user to put the value in `.env`
  (check that `.env` is ignored by git). Never write a real password into the product
  file, and never read one out of `.env`.
- **Data about people**: the video is made to be shared. Tell the AI to use made-up names
  and `@example.com` addresses, and blur anything private with `blur: ".api-key, #email"`.
- **Risky actions**: AppStory never deletes, pays, sends emails or invites users unless
  `allow:` lists them. Do not add to `allow:` unless the user asks for it.
- **Reset**: if a demo creates a record, add `reset:` with the command that puts the demo
  data back (a seed script), so a second run does not show it twice.
- **Branding**: `color:`, `logo:`, `font:`, `background:` and `website:` (the public address
  the video shows instead of localhost) are optional; take them from the project if they
  are clear (the brand colour in the CSS, the logo in `public/`).

## 4. Check it, then make the video

```bash
npx app-story check <name>          # settings, keys, login, the app, local tools: fix what it reports
npx app-story <name>                # one video of what's new in the release notes
npx app-story <name> --each         # one video per new feature
npx app-story <name> "show how to export a report"   # a video of anything else
npx app-story <name> --videos       # one video per goal under "## Videos" in the product file
```

When the user wants the same few videos again and again, list their goals under a
`## Videos` heading in the product file, one per line, and use `--videos`.

A video takes a few minutes and uses the AI key, which costs money: tell the user before
the first run. Once a plan works, it is saved in `apps/<name>.plans/` and replayed with
no AI cost; suggest committing that folder.

## 5. Hand over

Tell the user where the files are, in `output/<name>/`: the `.mp4`, its captions (`.srt`),
its thumbnail (`.png`), a description for YouTube (`.description.txt`) and a short post to
share it with (`.post.txt`), plus any `vertical`, `square` or `gif` versions the product
file asked for. If a run failed, `npx app-story resume <name>` finishes it without planning
again. If they want the videos kept up to date, `npx app-story test <name>` checks every
saved plan in CI (see the README's "Plans as tests, CI and Playwright").
