# Licenses of what AppStory uses

AppStory is MIT licensed. Everything it installs, downloads or ships is free to use,
including commercially, so a team can publish the videos it makes. This page lists each
part and its licence, and the rule for adding new ones.

## npm packages

| Package | Used for | Licence |
| --- | --- | --- |
| `playwright` | drives Chromium, records it, renders the video | Apache-2.0 |
| `react`, `react-dom` | the video's compositions (bundled into the render page) | MIT |
| `esbuild` | bundles the render page | MIT |
| `@fontsource-variable/inter` | the Inter font, shipped with the render page | OFL-1.1 (font), MIT (package) |
| `kokoro-js`, `phonemizer` | the free local Kokoro voice | Apache-2.0 |
| `@huggingface/transformers`, `onnxruntime-*` | runs Kokoro and the word timing model locally | Apache-2.0, MIT |
| `@anthropic-ai/sdk`, `openai` | the AI providers (`openai` also talks to local servers) | Apache-2.0 |
| `zod`, `yaml`, `commander`, `pino`, `pino-pretty`, `tsx`, `dotenv` | settings, CLI, logs | MIT, ISC, BSD-2-Clause |

## Programs AppStory runs

| Program | Licence | Note |
| --- | --- | --- |
| Chromium (installed by Playwright) | BSD-3-Clause and others | |
| FFmpeg, with libx264 | GPL-2.0-or-later (with x264) | Run as a separate program, never linked, so AppStory stays MIT. The Docker image installs Debian's FFmpeg package, whose sources Debian publishes. The videos you make are yours: the encoder's licence does not cover its output. |
| Python with `chatterbox-tts` (optional) | MIT | Only for `voice: chatterbox`; installed by the user. |

## Models, downloaded on first use

| Model | Used for | Licence of the weights |
| --- | --- | --- |
| `onnx-community/Kokoro-82M-v1.0-ONNX` | the Kokoro voice | Apache-2.0 |
| `onnx-community/whisper-base.en_timestamped` (from `openai/whisper-base.en`) | timing English words | Apache-2.0 |
| `onnx-community/whisper-base_timestamped` (from `openai/whisper-base`) | timing words in other languages | Apache-2.0 |
| `ResembleAI/chatterbox` (Chatterbox and Chatterbox Multilingual) | the Chatterbox voice | MIT |

The paid voices (OpenAI, ElevenLabs) and AI providers (Anthropic, OpenAI) are services
under their own terms; AppStory only calls them when a product file picks them. With
`ai: local`, the model is whatever your server runs: check its licence yourself.

## Media you add

`logo:`, `font:` and `music:` are your own files. Use only what you may publish: a font
under the OFL or your own licence, and music you own or that is CC0 (public domain, no
credit needed) or CC-BY (credit it in the video's description).

## Adding something new

Code, fonts, models and media each have their own licence; check the one you would ship
or download, not only the repository's. Allowed: MIT, Apache-2.0, BSD, ISC, MPL-2.0 for
code; OFL for fonts; CC0 and CC-BY for media and model weights. Not allowed, because users
could not make commercial videos with them: anything "non-commercial" (CC-BY-NC, such as
the F5-TTS, MusicGen and MMS weights), the Coqui Public Model License (XTTS), and
source-available licences that charge companies (such as Remotion's). Add the new part to
the tables above in the same pull request.
