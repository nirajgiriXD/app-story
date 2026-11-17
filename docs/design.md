# AppStory design brief

> The original design brief that AppStory was built from. Where it describes product
> folders, `product.yaml`, scenarios or other commands, sections 5 to 9 have been
> updated to the current one-file design. Videos are no longer rendered with Remotion,
> as planned below, but in headless Chromium and FFmpeg. For how to use AppStory, see the
> [README](../README.md); for how the code fits together, see [architecture.md](architecture.md).

---

## 1. Vision

AppStory should be a generic, reusable product-demo generation engine.

It must not contain business logic or assumptions specific to any particular application.

It should work with different kinds of web applications, including:

- SaaS dashboards
- Admin panels
- CRM and ERP systems
- E-commerce platforms
- Project management applications
- Developer tools
- Billing and subscription platforms
- WordPress applications
- Custom web applications

A user should be able to configure a product once and generate multiple videos for its features, releases, onboarding workflows, and product updates.

### Example

A user configures:

```yaml
product:
  name: EasyDash
  description: WordPress hosting management platform
  base_url: https://demo.example.com

demo:
  title: Managing WordPress Backups
  objective: Demonstrate how users can create and restore backups
  audience: Existing customers
  duration: 90
```

AppStory should:

1. Understand the product and the requested demonstration.
2. Use the configured AI provider to plan the demonstration.
3. Identify the necessary pages, interactions, and expected outcomes.
4. Execute the workflow using Playwright.
5. Record the actual application interface.
6. Generate narration and subtitles.
7. Render a professional video.
8. Save the final video and supporting assets.

---

## 2. Core Design Principles

### Generic by design

The engine must be independent of the application being demonstrated.

Product-specific configuration, authentication, navigation, workflows, and test data must live outside the core engine.

### AI-provider independent

Support both Anthropic Claude and OpenAI as first-class AI providers.

Users must be able to select their preferred provider and model without modifying the source code.

The core agent orchestration, workflow engine, and browser controller must not depend directly on either provider.

### Real application interaction

Demonstrations must show the actual application interface.

Use Playwright to interact with real browser pages, buttons, forms, dialogs, menus, tables, and other UI elements.

Do not generate fake application screenshots or simulated interfaces as substitutes for the actual product.

### Controlled execution

The AI agent must not have unrestricted authority to perform arbitrary actions.

All browser actions must go through a controlled Playwright execution layer with:

- Allowed browser operations.
- Configurable URL restrictions.
- Execution timeouts.
- Sensitive-action restrictions.
- Action logging.
- Screenshot checkpoints.
- Verification of expected outcomes.

### Professional video output

The final output should resemble a professionally produced SaaS product demonstration, not an unedited screen recording.

Use narration, captions, transitions, zoom effects, cursor highlighting, section titles, and consistent branding.

---

## 3. Technology Stack

Use the following stack unless a strong technical reason requires an alternative.

| Component | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| Package manager | npm (workspaces) |
| AI agent architecture | Provider-agnostic |
| AI providers | Anthropic Claude, OpenAI |
| AI SDKs | Official Anthropic SDK, OpenAI SDK |
| Browser automation | Playwright |
| Browser | Chromium |
| Schema validation | Zod |
| Video composition | Remotion |
| Video processing | FFmpeg |
| Text-to-speech | Configurable TTS provider |
| Initial TTS options | Kokoro (free, local, default), OpenAI, ElevenLabs |
| Captions | SRT / WebVTT generation |
| Configuration | YAML |
| CLI | Commander.js |
| Logging | Pino |
| Testing | Vitest + Playwright |
| Storage | Local filesystem initially |
| Future storage | S3-compatible storage |

Use current stable versions and maintain compatibility between dependencies.

The first version should be a CLI-based application. Do not build a dashboard or SaaS platform before the core engine works.

---

# 4. Architecture

Build AppStory as a modular system with clearly separated responsibilities.

```text
                         AppStory
                             |
                             v
                     Configuration Loader
                             |
                             v
                       Demo Orchestrator
                             |
              +--------------+--------------+
              |              |              |
              v              v              v
          Product         AI Agent       Workflow
          Adapter         Provider        Planner
              |          (Claude /          |
              |           OpenAI)           |
              +--------------+--------------+
                             |
                             v
                     Execution Planner
                             |
                             v
                    Playwright Controller
                             |
                             v
                     Browser Automation
                             |
                             v
                     Screen Recording
                             |
              +--------------+--------------+
              |              |              |
              v              v              v
          Narration       Captions       Video Assets
          Generator       Generator      Processor
              |              |              |
              +--------------+--------------+
                             |
                             v
                      Remotion Renderer
                             |
                             v
                       Final MP4 Video
```

## 4.1 Configuration Loader

Loads and validates product configuration, environment variables, demo requirements, browser settings, branding, and provider settings.

Use Zod schemas for all configuration and AI-generated data.

## 4.2 Product File

All product-specific context lives in one Markdown file per product, outside the engine:
its address and login (in a settings block read by code), and a plain-English description,
tips and release notes (read by the AI). The engine contains no product-specific logic.

## 4.3 AI Agent

AppStory must support multiple AI providers, with **Anthropic Claude and OpenAI as first-class providers**.

The user must be able to choose which AI provider powers the agent through product configuration, environment variables, or CLI options.

The core agent orchestration must remain independent of any specific AI provider.

### Supported AI providers

- Anthropic Claude.
- OpenAI.

Use the official SDKs for each provider.

### Agent responsibilities

The AI agent should be capable of:

1. Understanding the requested demonstration.
2. Reviewing available product documentation.
3. Exploring the application in a controlled discovery mode.
4. Identifying relevant pages and workflows.
5. Producing a structured execution plan.
6. Selecting suitable browser actions.
7. Observing browser results and tool outputs.
8. Recovering from reasonable UI failures.
9. Verifying expected outcomes.
10. Preparing narration and video section descriptions.

### Provider abstraction

Implement a common AI provider interface so the core application does not depend directly on Claude or OpenAI.

Illustrative interface:

```ts
interface AIProvider {
  generateStructuredOutput<T>(
    request: StructuredGenerationRequest<T>
  ): Promise<T>;

  generateText(
    request: TextGenerationRequest
  ): Promise<string>;

  executeAgentTurn(
    request: AgentTurnRequest
  ): Promise<AgentTurnResult>;
}
```

The exact interface may be refined during implementation. Ensure it supports the common capabilities needed by the agent without leaking provider-specific SDK types into the core packages.

Suggested implementation:

```text
packages/ai/src/
├── providers/
│   ├── provider.interface.ts
│   ├── anthropic/
│   │   ├── anthropic.provider.ts
│   │   └── anthropic.models.ts
│   └── openai/
│       ├── openai.provider.ts
│       └── openai.models.ts
├── agents/
├── prompts/
├── tools/
├── factory/
└── contracts/
```

### Provider selection

Example Claude configuration:

```yaml
providers:
  ai:
    provider: anthropic
    model: claude-sonnet-latest
    temperature: 0.2
    max_iterations: 20
```

Example OpenAI configuration:

```yaml
providers:
  ai:
    provider: openai
    model: gpt-5
    temperature: 0.2
    max_iterations: 20
```

Model identifiers must be configurable rather than hardcoded into the application. Use valid model identifiers supported by the respective APIs.

### Credentials

Use environment variables:

```env
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

Never store API keys in product YAML files or commit them to Git.

### Provider override

The product file picks the provider (`ai: openai`); without it, AppStory uses the one
that has a key. For a single run, override it from the environment:

```bash
APP_STORY_AI_PROVIDER=openai app-story easydash
```

### Important implementation requirements

- Claude and OpenAI must both support the same core agent capabilities.
- Support structured output and tool calling through the provider abstraction.
- Normalize provider-specific tool calls and responses into common internal contracts.
- Keep prompts and agent orchestration provider-independent wherever practical.
- Handle provider-specific API errors, rate limits, retries, and token usage.
- Track the provider and model used for every generation job.
- Never silently switch providers if the configured provider fails.
- A fallback is used only when keys for both providers are present, only after a
  provider error, and every switch is recorded in the job metadata and shown to the user.
- Allow different models to be selected without modifying source code.
- Test both providers independently against the same agent workflow contracts.
- Do not make the rest of the application depend on provider-specific message formats.

## 4.4 Workflow Planner

Convert the demonstration objective into a structured, executable workflow.

Example:

```json
{
  "title": "Create a WordPress backup",
  "objective": "Demonstrate how a user creates a backup",
  "steps": [
    {
      "description": "Open the website dashboard",
      "action": "navigate",
      "target": "/websites"
    },
    {
      "description": "Open the target website",
      "action": "click",
      "target": "Website card"
    },
    {
      "description": "Open the backup section",
      "action": "click",
      "target": "Backups"
    },
    {
      "description": "Start a new backup",
      "action": "click",
      "target": "Create Backup"
    },
    {
      "description": "Verify the backup was created",
      "action": "verify",
      "expected": "Backup appears in the backup list"
    }
  ]
}
```

This is an illustrative schema. Implement a robust, versioned workflow contract rather than relying on this exact example.

The workflow must support:

- Navigation.
- Clicks.
- Form filling.
- Dropdown selection.
- Hovering.
- Scrolling.
- Keyboard input.
- Waiting.
- Screenshots.
- Assertions.
- Conditional steps.
- Recovery instructions.
- Optional setup and cleanup operations.

Prefer accessible selectors, labels, roles, and text-based locators. Use CSS selectors only when necessary.

The planner must not invent successful outcomes. Every important outcome must be verified through the browser.

## 4.5 Playwright Controller

Responsible for all actual browser interaction.

Requirements:

- Chromium support.
- Configurable viewport and device scale factor.
- Configurable browser context.
- Authentication support.
- Cookie and storage-state support.
- Network and navigation timeouts.
- Screenshot capture.
- Video recording.
- Browser console error collection.
- Failed network request collection.
- Trace recording for debugging.
- Automatic cleanup.
- Isolated browser contexts for concurrent jobs.

Use Playwright's native recording capabilities or an equivalent reliable recording implementation.

Keep raw recordings separate from final rendered videos.

## 4.6 Recording and Video Engine

The video engine must turn browser recordings into polished videos.

Use Remotion for composition and FFmpeg for encoding and media processing.

Support:

- Intro title.
- Product branding.
- Feature title cards.
- Browser recordings.
- Zoom and focus effects.
- Cursor highlighting.
- Click emphasis.
- Smooth transitions.
- Narration.
- Background music.
- Captions.
- Outro.
- Configurable resolution and frame rate.

Default output:

```text
1920x1080
30 FPS
MP4
H.264 video
AAC audio
```

The renderer should use reusable templates rather than hardcoded compositions for individual products.

## 4.7 Narration Generator

Generate narration based on the actual execution plan and verified browser results.

Narration must explain what the viewer is seeing and why the demonstrated functionality matters.

Requirements:

- Natural conversational language.
- Concise sentences.
- No unnecessary repetition.
- Product-appropriate terminology.
- Synchronization with video scenes.
- Configurable voice and language.
- Configurable speaking speed.
- Support for multiple TTS providers.

Never narrate an action as successful before it has been verified.

Generate timestamps or scene-level narration metadata to support synchronization.

## 4.8 Caption Generator

Generate subtitles from narration.

Support:

- SRT.
- WebVTT.
- Optional embedded subtitles.
- Configurable font, size, and position.

Subtitles should be readable and must not obstruct important application UI elements.

---

# 5. Product Configuration

Every product is one file, `products/<id>.md`. The full format is in
["Product files"](../README.md#product-files) in the README.

```markdown
---
url: https://demo.example.com
login: demo@example.com / env:EASYDASH_PASSWORD
---

# EasyDash

WordPress hosting management platform for agencies.

## Tips for the demo
- Backups live under Sites → Backups.

## Release notes
### Added
- One-click restore from any backup.
```

Only `url` is required. Optional settings: `login`, `login page`, `start page`, `ai`,
`model`, `voice`, `length`, `language`, `logo`, `color`, `allow`. Everything else (browser,
recording, captions, safety) has defaults in the engine.

Secrets must never be committed: `env:NAME` reads a value from the git-ignored `.env`.

---

# 6. Demo Generation Modes

## From release notes (default)

```bash
app-story easydash            # one video of everything new
app-story easydash --each     # one video per new feature (two are made at a time)
```

The AI picks the new user-visible features from the release notes, then plans, verifies,
records and narrates each one.

## From a plain-language goal

```bash
app-story easydash "Demonstrate how to create and restore a website backup"
```

## Repeatable runs

Each verified plan is saved in the database and replayed by the next video of the same
feature, without AI planning. Its narration and voice clips are reused too. It is
re-planned automatically when the feature text changes or the app no longer matches it, or
on `--fresh`.

---

# 7. CLI Interface

```bash
app-story <product> [goal]      # make videos (--each, --fresh, --headed)
app-story new <name>            # create products/<name>.md
app-story check <product>       # settings, keys, login, the app, local tools
app-story list                  # list products
app-story history [product]     # recent videos
```

---

# 8. Project Structure

Use an npm workspaces monorepo. What users touch stays at the top level; everything else
lives in `engine/`.

```text
app-story/
├── products/                 user-owned: one file per product
│   └── example.md            the practice app
│
├── output/                   finished videos only (git-ignored)
├── docs/
│
├── engine/                   AppStory itself
│   ├── cli/                  the app-story command
│   ├── packages/
│   │   ├── core/             orchestrator, pipeline, rehearsal agent, plans, job-manager, SQLite store
│   │   ├── ai/               providers, tool loop, prompts, factory
│   │   ├── browser/          playwright, auto login, controller, recording, security
│   │   ├── workflow/         executor, validators
│   │   ├── products/         product file reader
│   │   ├── narration/        generator, providers, synchronization
│   │   ├── video/            remotion, compositions, templates
│   │   ├── captions/
│   │   ├── contracts/
│   │   └── shared/
│   │
│   ├── data/                 SQLite database and scratch folders (git-ignored),
│   │                         example-app/ (tiny fake app for practice and tests)
│   ├── tests/                unit/, integration/, e2e/, support/, fixtures/
│   ├── scripts/
│   ├── tsconfig.json, tsconfig.base.json
│   └── vitest.config.ts
│
├── .env.example
├── .gitignore
├── package.json              npm workspaces: engine/cli, engine/packages/*
└── README.md
```

Keep modules independently testable. Avoid circular dependencies and unnecessary abstraction.

---

# 9. Output Structure

`output/` receives only finished videos:

```text
output/
  easydash/
    20261116-134205-a1b2c3-website-backup.mp4
```

Everything else is in the SQLite database `engine/data/app-story.db`: the `jobs` table
(product, objective, timestamps, AI provider and model, voice, workflow version, status,
recording duration, video path, token usage and estimated AI cost, errors), `job_records`
(settings used, plan, practice run, narration, captions, reports, quality checks, log,
thumbnail) and `plans` (saved click-plans). A job's scratch files live in
`engine/data/work/<job>/`, deleted on success and kept on failure for troubleshooting.

---

# 10. Agent Execution and Reliability

This is one of the most important parts of AppStory.

The agent must be capable of handling real-world application differences without turning every workflow into unreliable autonomous browsing.

Implement a controlled agent loop:

```text
1. Receive demonstration objective.
2. Load product configuration and knowledge.
3. Initialize the configured AI provider.
4. Inspect the current browser state.
5. Ask the AI agent to plan the next actions.
6. Validate the proposed actions.
7. Execute actions through Playwright.
8. Capture the resulting browser state.
9. Verify expected outcomes.
10. Ask the AI agent to recover if a recoverable failure occurs.
11. Continue until the workflow is complete.
12. Generate narration from verified events.
13. Render the video.
14. Produce a generation report.
```

Requirements:

- Maximum agent iterations.
- Maximum execution duration.
- Per-action timeout.
- Retry policy.
- Recovery policy.
- Structured execution logs.
- Failure screenshots.
- Playwright traces.
- Agent token and cost tracking.
- Clear failure reasons.

The system must distinguish between:

- Successful execution.
- Successful execution with warnings.
- Recoverable failure.
- Workflow failure.
- Application unavailable.
- Authentication failure.
- Unsupported workflow.

Never silently produce a video from an incomplete or unverified workflow.

### AI provider fallback

Provider fallback must be optional and explicitly configured.

For example, a user may configure OpenAI as the primary provider and Claude as the fallback provider.

However:

- Never switch providers without recording the switch.
- Never silently switch models.
- Preserve the original job context when possible.
- Handle incompatible tool-call formats through the provider adapter.
- Report provider failures and fallback attempts in job metadata.

---

# 11. Security

AppStory will interact with real applications, so security must be part of the architecture.

Implement:

1. Explicit allowed-domain configuration.
2. Browser navigation restrictions.
3. Secret redaction in logs and screenshots where practical.
4. No hardcoded credentials.
5. No arbitrary shell execution by the AI agent.
6. No unrestricted filesystem access by the AI agent.
7. Restricted browser tool permissions.
8. Destructive-action protection.
9. Execution timeouts and resource limits.
10. Isolated browser contexts.
11. Secure handling of authentication state.
12. Safe handling of untrusted page content.

Treat website content as untrusted input. A webpage may contain prompt-injection instructions. Such content must never override AppStory system policies or tool permissions.

Support configurable restrictions for:

- Deleting records.
- Making payments.
- Sending emails.
- Publishing content.
- Changing account settings.
- Inviting users.
- Modifying production data.

By default, do not execute destructive, financial, or externally consequential operations.

For initial development, use dedicated demo environments with synthetic data. Do not record real customer data or production secrets.

---

# 12. Video Design System

Video quality is a major part of this project.

Build reusable compositions with a premium, minimal SaaS aesthetic.

Avoid generic AI-generated video styling.

Design guidelines:

- Clean typography.
- Consistent spacing.
- Smooth transitions.
- Restrained motion.
- Clear hierarchy.
- Product-first visuals.
- Readable captions.
- Professional narration.
- Minimal visual clutter.

Support configurable templates:

```text
templates/
  minimal/
  modern-saas/
  product-update/
  tutorial/
  feature-highlight/
```

Each template should control:

- Intro and outro.
- Typography.
- Brand colors.
- Transitions.
- Caption appearance.
- Zoom behavior.
- Background music.
- Section titles.

The template system should be extensible without changing the browser automation engine.

---

# 13. Quality Assurance

A video should not be considered successful merely because the browser recording completed.

Implement quality checks.

### Workflow validation

- Did all required steps execute?
- Were expected outcomes verified?
- Did any unexpected navigation occur?
- Were there browser errors?
- Did the workflow stop at the intended endpoint?

### Recording validation

- Is the recording present?
- Is the recording playable?
- Is the duration reasonable?
- Is the viewport correct?
- Is the browser UI appropriately presented?

### Audio validation

- Is narration present?
- Is audio duration valid?
- Are there missing or silent segments?
- Are captions generated?

### Final video validation

- Is the MP4 valid?
- Is the resolution correct?
- Is audio synchronized?
- Are captions readable?
- Is the thumbnail generated?

Generate a quality report for every job.

Include a human approval stage before publishing videos. The initial release must not automatically publish generated videos to public channels.

---

# 14. Extensibility

Design the application around provider interfaces.

The following must be replaceable without changing the core orchestration logic.

### AI providers

Initially:

- Anthropic Claude.
- OpenAI.

Future:

- Additional LLM providers through the same interface.

### Browser providers

Initially:

- Playwright + Chromium.

Keep the browser interface abstract enough to support additional browser engines later.

### TTS providers

Initially:

- ElevenLabs.
- OpenAI.

Future providers should be implementable through a common interface.

### Storage providers

Initially:

- Local filesystem.

Future:

- Amazon S3.
- Cloudflare R2.
- Other S3-compatible storage.

Do not overengineer these abstractions. Introduce provider interfaces where there is a clear integration boundary.

---

# 15. Development Roadmap

Implement the project in phases.

Do not attempt to implement everything in one pass.

## Phase 1 — Foundation

- Set up npm workspaces monorepo.
- Configure TypeScript.
- Implement CLI.
- Implement product configuration loader.
- Implement Zod contracts.
- Implement logging.
- Add `.env.example`.
- Add unit tests.

**Deliverable:** A working CLI that can initialize and validate a product configuration.

## Phase 2 — Browser Automation

- Integrate Playwright.
- Launch Chromium.
- Support authentication.
- Implement browser controller tools.
- Capture screenshots.
- Record browser sessions.
- Implement execution logs.

**Deliverable:** A configured product can be opened and a deterministic browser workflow can be executed and recorded.

## Phase 3 — AI Provider Architecture

- Implement common AI provider interfaces.
- Integrate Anthropic SDK.
- Integrate OpenAI SDK.
- Implement provider factory.
- Implement provider-specific tool calling.
- Normalize tool calls and responses.
- Implement structured output validation.
- Implement model configuration.
- Add provider-specific error handling.
- Add tests for both providers.

**Deliverable:** Users can switch between Claude and OpenAI without changing the workflow engine.

## Phase 4 — AI Agent and Workflow Planning

- Implement agent orchestration.
- Implement controlled browser tools.
- Implement application discovery.
- Generate structured execution plans.
- Validate agent output.
- Implement execution and recovery loop.

**Deliverable:** Either AI provider can plan and execute a simple product workflow through Playwright.

## Phase 5 — Narration

- Generate narration scripts.
- Integrate the selected TTS provider.
- Generate audio.
- Generate captions.
- Synchronize narration with recorded scenes.

**Deliverable:** A recorded workflow with narration and subtitles.

## Phase 6 — Video Rendering

- Set up Remotion.
- Create reusable video compositions.
- Integrate FFmpeg.
- Implement branding.
- Add titles and transitions.
- Add cursor and zoom effects.
- Generate thumbnails.

**Deliverable:** A polished 1080p product demo video.

## Phase 7 — Reliability and Production Readiness

- Add comprehensive validation.
- Add retries and recovery.
- Add execution reports.
- Add cost tracking.
- Add security controls.
- Add concurrency limits.
- Add integration tests.
- Document deployment and usage.

**Deliverable:** A stable, reusable demo-generation CLI.

---

# 16. First End-to-End Milestone

Before building the entire system, complete one working vertical slice.

Use a simple test web application with synthetic data.

The program should accept:

```bash
app-story example "Demonstrate how to create a new project"
```

It must then:

1. Load the product configuration.
2. Initialize the configured AI provider.
3. Start Chromium.
4. Navigate to the configured application.
5. Use the AI agent to plan the demonstration.
6. Execute the plan through controlled Playwright tools.
7. Verify that the project was created.
8. Record the browser interaction.
9. Generate narration.
10. Generate subtitles.
11. Render a final MP4.
12. Save all assets and a metadata report.

The same workflow must work with both Claude and OpenAI by changing configuration or using the CLI override.

The result must be a real, playable product demo video.

Do not proceed to complex features until this complete flow works reliably.

---

# 17. Development Instructions

Follow these implementation rules:

- Use TypeScript throughout.
- Enable strict TypeScript checking.
- Prefer small, cohesive modules.
- Avoid giant orchestrator classes.
- Keep AI prompts versioned and separate from implementation code.
- Validate all external inputs and AI-generated outputs.
- Keep product-specific logic outside core packages.
- Use dependency injection at meaningful provider boundaries.
- Write unit tests for core logic.
- Write integration tests for provider integrations.
- Use deterministic test fixtures.
- Avoid unnecessary dependencies.
- Avoid premature microservices.
- Provide useful CLI errors.
- Document environment variables.
- Do not hardcode API keys or credentials.
- Keep the first version local-first.
- Do not build a frontend dashboard in the initial release.
- Keep Claude and OpenAI integrations isolated behind a common interface.
- Never expose provider-specific SDK objects to the workflow engine.
- Maintain clear separation between AI planning, browser execution, verification, and video rendering.

Use conventional commits and maintain a clean Git history.

Every implementation phase must leave the project in a working state.

---

# 18. Definition of Done

The initial release is complete when a user can:

1. Install AppStory.
2. Initialize a product.
3. Configure its URL and authentication.
4. Select Anthropic Claude or OpenAI.
5. Select the desired AI model.
6. Provide a natural-language demonstration objective.
7. Let the configured AI agent plan the workflow.
8. Execute the workflow using Playwright.
9. Record the real application interface.
10. Generate natural narration.
11. Generate subtitles.
12. Render a professional MP4.
13. Review the generated video and execution report.
14. Repeat the process for another product without modifying AppStory's core code.
15. Switch AI providers without changing product configurations or workflow implementations unnecessarily.

**The ultimate objective: one reusable engine, multiple products, multiple AI providers, automated product demonstrations, and minimal manual video editing.**