# Contributing to AppStory

Thanks for helping. This guide covers how to set up the project, check your change, and
send it in. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security problem? Do not open an issue; follow [SECURITY.md](SECURITY.md).

## Before you start

- **Bugs and small fixes:** open a pull request, or an issue first if you are unsure it
  is a bug.
- **New features or bigger changes:** open an issue first, so we can agree on the idea
  before you spend time on it.

## Set up

You need Node.js 22.13 or newer, a recent npm (GitHub Actions uses npm 12), and FFmpeg
(`ffmpeg` and `ffprobe` on your PATH).

```bash
git clone https://github.com/nirajgiriXD/app-story.git
cd app-story
npm install
npm run browsers:install       # Chromium for Playwright
cp .env.example .env           # then add an Anthropic or OpenAI key
```

Try it on the practice app:

```bash
npm run example-app            # terminal 1: a tiny app at http://localhost:4310
npx app-story example          # terminal 2
```

More detail is in [docs/getting-started.md](docs/getting-started.md). How the parts fit
together is in [docs/architecture.md](docs/architecture.md).

## Check your change

Run these before you open a pull request. GitHub Actions runs them too.

```bash
npm run lint                   # Biome: lint and formatting
npm run typecheck              # TypeScript
npm test                       # unit tests (fast, no browser, no AI)
npm run test:integration       # a real browser, FFmpeg and the Kokoro voice; no AI key
```

- `npm run lint:fix` fixes what Biome can fix by itself, and `npm run format` formats
  every file. Biome skips Markdown, so prompts and product files are never reformatted.
- Run the integration tests when you touch the browser, recording, narration or video.
  They take several minutes, and the first run downloads the voice model (~330 MB).
- `npm run test:e2e` makes a real video with real AI answers recorded once in
  `engine/tests/fixtures/ai-answers/<provider>.json`, so replaying them is free and needs
  no key. Record them (needs the key, costs a little) with
  `APP_STORY_RECORD_AI=1 npm run test:e2e`, and commit the new files; do it again after
  changing a prompt, the AI tools or the practice app. Without recorded answers the e2e
  tests are skipped locally, and fail on CI so a run that tested nothing never passes.

## Writing code

- **Tests.** Add or update tests for the behavior you change: unit tests in
  `engine/tests/unit/`, browser tests in `engine/tests/integration/`. Fakes for the AI,
  the voice and the browser are in `engine/tests/support/`. Unit tests run on Linux and
  Windows in CI.
- **Database.** To change the tables in `engine/packages/core/src/store/store.ts`, add a
  new entry to `MIGRATIONS`; never edit one that has shipped.
- **AI prompts** live in `engine/packages/ai/src/prompts/` as `name.vN.md`. When you
  change what a prompt means, add a new version file and bump it in `PROMPT_VERSIONS`
  (`prompts/index.ts`), instead of editing the old one.
- **Safety.** Do not weaken the browser's guards (`engine/packages/browser/src/security/`)
  or let website text act as instructions. Treat everything on a page as untrusted.
- **No secrets or real data.** Never put passwords, API keys or real customer data in
  code, tests, fixtures, product files or screenshots. Use `env:NAME` and made-up data.
- **Docs.** If you change a setting, a command or what users see, update the README or
  `docs/` in the same pull request.

## Releases

The npm package and the Docker image are published by GitHub Actions
(`.github/workflows/release.yml`) when a version tag is pushed:

1. Set the new version in `engine/cli/package.json` and in `engine/cli/src/program.ts`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.

Publishing to npm needs an `NPM_TOKEN` secret in the repository settings. The image goes
to `ghcr.io/nirajgirixd/app-story`. To try the package locally: `npm run build`, then
`npm pack ./dist/app-story` and install the `.tgz` in another folder.

## Commits and pull requests

- Write commit messages in [Conventional Commits](https://www.conventionalcommits.org/)
  style: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `perf:`, `chore:`. Add a scope
  when it helps, for example `fix(browser): ...`.
- Keep one concern per commit and per pull request. Small pull requests are reviewed
  faster.
- Fill in the pull request template: what changed, why, and how you tested it.

## Troubleshooting

**Windows: tests fail with "expected RateLimitError to match", or other `instanceof`
checks fail.** npm links the workspace packages using the drive letter of the shell it
ran in. Git Bash says `c:`, while Vitest uses `C:`, so the same library can load twice.
Run `npm install` from PowerShell or Command Prompt, then delete
`node_modules/.vitest-cache` and run the tests again.
