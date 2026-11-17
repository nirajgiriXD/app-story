# AppStory in CI

Once a video has been made, its plan (`products/<product>.plans/<name>.yaml`) holds the
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
      - uses: nirajgiriXD/app-story@main
        with:
          products: acme
          command: test
          version: 0.1.0
          env-vars: ACME_PASSWORD
        env:
          ACME_PASSWORD: ${{ secrets.ACME_PASSWORD }}

      # Makes every saved plan's video again and uploads output/ as an artifact.
      - uses: nirajgiriXD/app-story@main
        with:
          products: acme
          version: 0.1.0
          env-vars: ACME_PASSWORD
        env:
          ACME_PASSWORD: ${{ secrets.ACME_PASSWORD }}
```

| Input | Default | What it is |
| --- | --- | --- |
| `products` | (required) | product names, separated by spaces |
| `command` | `replay` | `replay` makes the videos again; `test` only checks the plans |
| `plans` | all | plan names, separated by spaces |
| `env-vars` | | names of variables to pass in: the passwords your product files read with `env:NAME` |
| `version` | `latest` | the AppStory Docker image tag; pin it so videos do not change by themselves |
| `image` | | a full image name instead, e.g. one you built |
| `working-directory` | `.` | the folder with `products/` |
| `upload` | `true` | upload `output/` as an artifact after `replay` |
| `artifact-name` | `app-story-videos` | the artifact's name |

AI keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`) and `APP_STORY_*`
settings in the job's environment are passed in by themselves. They are only needed for a
plan that has no saved narration yet (an imported one), or for a paid voice.

## Elsewhere

Any CI with Docker can run the same commands:

```bash
docker run --rm --network host -v "$PWD:/work" -e ACME_PASSWORD ghcr.io/nirajgirixd/app-story test acme
docker run --rm --network host -v "$PWD:/work" -e ACME_PASSWORD ghcr.io/nirajgirixd/app-story replay acme
```

## What changes a video

`replay` records the app again, so the video shows the app as it is now, with the same
clicks and words. When a plan fails, the app changed under it: make the video again
locally (`npx app-story acme`), which plans it again, and commit the new plan file.
