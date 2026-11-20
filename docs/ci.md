# AppStory in CI

Once a video has been made, its plan (`apps/<product>.plans/<name>.yaml`) holds the
clicks, the checks and the narration. Commit it: CI can then check that the plan still
works, and make the same video again, with no AI key.

## GitHub Actions

```yaml
name: Demo videos

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  videos:
    runs-on: ubuntu-latest   # the action needs Docker
    steps:
      - uses: actions/checkout@v5

      # Start your app so the runner can reach it, the way your own tests do.
      - run: docker compose up -d && npx wait-on http://localhost:3000

      # Fails when a plan no longer works in the app, naming the step that broke.
      - uses: nirajgiriXD/app-story@v0.1.0
        with:
          products: acme
          command: test
          env-vars: ACME_PASSWORD
        env:
          ACME_PASSWORD: ${{ secrets.ACME_PASSWORD }}

      # Makes every saved plan's video again and uploads output/ as an artifact.
      - uses: nirajgiriXD/app-story@v0.1.0
        with:
          products: acme
          env-vars: ACME_PASSWORD
        env:
          ACME_PASSWORD: ${{ secrets.ACME_PASSWORD }}
```

The action builds AppStory's Docker image from this repository, so nothing needs to be
installed or published. The build is kept in the GitHub Actions cache: the first run of a
version takes several minutes, later runs reuse it. Pin the action to a tag or a commit
(`@v0.1.0`, not `@main`), so the videos do not change by themselves.

| Input | Default | What it is |
| --- | --- | --- |
| `products` | (required) | product names, separated by spaces |
| `command` | `replay` | `replay` makes the videos again; `test` only checks the plans |
| `plans` | all | plan names, separated by spaces |
| `env-vars` | | names of variables to pass in: the passwords your product files read with `env:NAME` |
| `image` | | a full image name to run instead of building one, e.g. one you built and pushed |
| `working-directory` | `.` | the folder with `apps/` |
| `upload` | `true` | upload `output/` as an artifact after `replay` |
| `artifact-name` | `app-story-videos` | the artifact's name |

AI keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CUSTOM_AI_API_KEY` and `CUSTOM_AI_BASE_URL`, `ELEVENLABS_API_KEY`) and `APP_STORY_*`
settings in the job's environment are passed in by themselves. They are only needed for a
plan that has no saved narration yet (an imported one), or for a paid voice.

## Elsewhere

Any CI with Docker can build the image from this repository and run the same commands:

```bash
docker build -t app-story https://github.com/nirajgiriXD/app-story.git#v0.1.0
docker run --rm --network host -v "$PWD:/work" -e ACME_PASSWORD app-story test acme
docker run --rm --network host -v "$PWD:/work" -e ACME_PASSWORD app-story replay acme
```

## What changes a video

`replay` records the app again, so the video shows the app as it is now, with the same
clicks and words. When a plan fails, the app changed under it: make the video again
locally (`npx app-story acme`), which plans it again, and commit the new plan file.
