# output/ — finished videos appear here

Every `generate`, `run` or `discover` writes one folder:

```text
output/<product>/<demo>/<job-id>/
├── video/final.mp4        the demo video
├── video/thumbnail.png    a cover image
├── captions/              subtitles (.srt and .vtt)
├── narration/             the script and voice clips
├── metadata.json          status, AI provider, cost estimate, errors
├── quality.json           automatic checks on the video
└── logs/                  details for troubleshooting
```

`npx demoforge history` lists recent jobs. Everything in this folder except this file is
ignored by git, so it is safe to delete old jobs. Change the location with
`--output-dir` or `DEMOFORGE_OUTPUT_DIR`.
