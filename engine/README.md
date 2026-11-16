# engine/ — DemoForge itself

You do not need to change anything here to make videos. Your work happens in
`products/`, and the videos land in `output/`.

```text
engine/
├── cli/            the `demoforge` command (npx demoforge ...)
├── packages/       the building blocks
│   ├── core/         runs every step of a job, in order
│   ├── ai/           talks to Anthropic or OpenAI; plans the clicks
│   ├── browser/      drives a real Chromium browser and records the screen
│   ├── workflow/     checks and replays step-by-step demos
│   ├── narration/    writes the script and speaks it (Kokoro, OpenAI, ElevenLabs)
│   ├── captions/     subtitles
│   ├── video/        renders the final MP4 (Remotion)
│   ├── products/     reads the folders in products/
│   ├── contracts/    the shape of every config and result file
│   └── shared/       small helpers used everywhere
├── example-app/    a tiny fake app to practise on (npm run example-app)
├── tests/          unit, integration (real browser) and e2e (real AI) tests
├── scripts/        helper that starts the tests
├── tsconfig*.json  TypeScript settings
└── vitest.config.ts
```

How the parts fit together: [docs/architecture.md](../docs/architecture.md).
