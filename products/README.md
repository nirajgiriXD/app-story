# products/ — your products go here

One folder per product you want demo videos of. DemoForge never needs your product's
source code: it opens the running app in a browser, at the address in `product.yaml`.

```text
products/
└── <your-product>/      create with: npx demoforge init
    ├── product.yaml     REQUIRED  address, login, voice, branding, safety
    ├── features.md      what to demo (used by: generate --features)
    ├── instructions.md  tips for the AI: where to click, what to avoid
    ├── knowledge/       background facts about the product (*.md)
    ├── scenarios/       saved demos you reviewed and approved (*.yaml)
    ├── adapter.ts       optional code hooks, e.g. reset demo data before a run
    └── .env             this product's login (ignored by git; see .env.example)
```

`example/` is a complete, working product for the practice app (`npm run example-app`).
Copy it as a starting point, or use the references below.

Logins and other secret values go in the product's own `.env`, never in `product.yaml`.
`product.yaml` only names the variables (`username_env: MY_APP_USER`). A value that is
already set in the shell or the root `.env` wins over the product's `.env`.

Folders whose name starts with `_` or `.` are not treated as products.

---

## product.yaml

Every option, with its default. Only `version`, `product` and `providers` are required,
so copy just the lines you want to change.

```yaml
version: 1

product:
  id: my-app                      # lowercase-dashes, must match the folder name
  name: My App
  description: What the product does, in one line.
  base_url: https://demo.my-app.com
  start_path: /                   # page every run starts from

browser:
  viewport: { width: 1920, height: 1080 }
  device_scale_factor: 1          # e.g. 1600x900 at 1.2 records a sharp 1920x1080 with larger UI
  allowed_domains: []             # defaults to the base_url host; "*.my-app.com" allows subdomains
  locale: en-US
  timezone: UTC
  color_scheme: light
  headless: true
  navigation_timeout_ms: 30000
  action_timeout_ms: 10000

authentication:
  strategy: none                  # none | storage_state | form
  # storage_state:
  #   storage_state_path: .secrets/my-app-state.json   # create with `demoforge browser inspect --save-auth`
  # form:
  #   login_path: /login
  #   username_env: MY_APP_USER     # values come from this product's .env, never from this file
  #   password_env: MY_APP_PASSWORD
  #   username_label: Email
  #   password_label: Password
  #   submit_text: Sign in
  #   success_url_contains: /dashboard

demo:
  default_language: en            # Kokoro voices speak English only
  default_duration: 90            # seconds; guides planning and narration length
  default_resolution: 1080p       # 720p | 1080p | 1440p | 4k
  fps: 30
  template: modern-saas           # minimal | modern-saas | product-update | tutorial | feature-highlight
  # audience: Existing customers

branding:
  # logo: assets/logo.png         # relative to this folder
  primary_color: "#2563EB"
  accent_color: "#0F172A"
  font: Inter
  # background_music: assets/music.mp3
  music_volume: 0.08              # ducked automatically under narration

providers:
  ai:
    provider: anthropic           # anthropic | openai
    # model: claude-opus-5-5      # any valid model id; omit for the provider default
    # effort: high                # low | medium | high | xhigh | max
    # temperature: 0.2            # only sent to models that accept it
    max_iterations: 30
    max_duration_s: 900
    max_retries: 4
    # pricing: { input_per_mtok: 4, output_per_mtok: 20, cached_input_per_mtok: 0.2 }   # for cost estimates
  # ai_fallback:                  # optional; used only when the primary provider fails, always recorded
  #   provider: openai
  #   model: gpt-5
  tts:
    provider: kokoro              # kokoro (free, local, no key) | openai | elevenlabs | none (captions only)
    # voice: af_heart             # Kokoro: af_heart, af_bella, am_michael, bf_emma, bm_george, ...
    #                             # OpenAI: marin, ... | ElevenLabs: a voice id
    # model: gpt-4o-mini-tts      # OpenAI / ElevenLabs only
    speed: 1.0                    # 0.7 to 1.3
    # style: Calm, clear and friendly.   # OpenAI only

safety:
  environment: demo               # demo | staging | production (production = read-only browser)
  allow:
    delete: false
    payments: false
    emails: false
    publishing: false
    account_settings: false
    invite_users: false
    production_data: false
  blocked_keywords: []            # extra words that must never be clicked

recording:
  engine: cdp                     # cdp (sharp, recommended) | playwright
  jpeg_quality: 92
  min_step_ms: 900                # minimum time each step stays on screen
  typing_delay_ms: 45
  cursor_move_ms: 650
  trace: true                     # Playwright trace in logs/trace.zip

captions:
  enabled: true
  burn_in: true                   # draw captions into the video (SRT/VTT are always written)
  font_size: 38
  position: bottom                # bottom | top
  max_chars_per_line: 52
```

---

## features.md

Your release notes, as they are: a changelog, a "what's new" post, a bullet list, any
format. You never write steps. Then run:

```bash
npx demoforge generate --product <id> --features          # one video for all features
npx demoforge generate --product <id> --features --each   # one video per feature
npx demoforge generate --product <id> --features path/to/CHANGELOG.md   # any other file
```

The AI first reads the notes and picks the features a viewer can see in the app. It
skips bug fixes, performance and internal changes, and headings like "Added"/"Fixed",
and prints what it picked and skipped. Then, for each feature, it finds the clicks
in the real app by itself.

```markdown
## [2.4.0] - 2026-11-01
### Added
- Bulk export: export many records at once as CSV.
- Dark mode for the whole app.
### Fixed
- Crash when saving an empty report.
```

Optional: a hint like "Reports page, Export button in the top right" helps the AI find
a feature faster, especially one hidden in a menu.

---

## scenarios/&lt;scenario-id&gt;.yaml

A saved, step-by-step demo that replays the same way every time, without AI planning.
You rarely write one by hand: `generate --features --save-scenario` (or `--objective "..."
--save-scenario`) saves the AI's verified plan for you to review. Set `approved: true`
after checking it, then make videos with `generate --scenario <id>` or `--all`.

```yaml
workflow_version: 1
id: create-backup                 # must match the file name
title: Creating a backup
objective: Demonstrate how a user creates a backup
summary: Shown under the title on the intro card.
audience: Existing customers
approved: false                   # set to true after review; unapproved scenarios are refused
created_by: human

setup: []                         # steps run before recording starts (not shown in the video)

steps:
  - id: s1
    section: Find your site       # chapter title shown in the video
    description: Open the websites list
    action: navigate              # navigate | click | fill | select | check | uncheck | hover | scroll | press | wait | screenshot | assert
    url: /websites

  - id: s2
    description: Open the backups tab
    action: click
    # Targets: prefer role+name, label or text. css is a last resort.
    target: { role: tab, name: Backups }
    expected:                     # verified right after the action
      type: visible               # visible | hidden | text_present | text_absent | url_contains | title_contains | value_equals | count_at_least | custom
      target: { role: button, name: Create backup }

  - id: s3
    description: Dismiss the tips banner if it is there
    action: click
    target: { role: button, name: Got it }
    when: { type: visible, target: { role: button, name: Got it } }   # conditional step
    optional: true

  - id: s4
    description: Type the backup label
    action: fill
    target: { label: Label }
    value: Before plugin update   # {{env:NAME}} reads from .env; add `secret: true`
    narration: Give the backup a label you'll recognise later.   # optional; used instead of AI narration when every step has one

  - id: s5
    section: Confirm
    description: Check the backup is listed
    action: assert
    expected:
      type: text_present
      text: Before plugin update
      description: The new backup appears in the list
    recovery: If the list is still loading, wait and check again.

cleanup: []                       # steps run in a separate session after recording
```
