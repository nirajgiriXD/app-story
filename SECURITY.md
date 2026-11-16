# Security Policy

AppStory logs in to real web apps, drives a real browser and uses your AI API keys.
Security problems in it are taken seriously, and reports are welcome.

## Supported versions

AppStory has no numbered releases yet. Security fixes go to the `main` branch, so please
check that a problem still happens on the latest `main` before reporting it.

## How to report a problem

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub instead:
[Report a vulnerability](https://github.com/nirajgiriXD/app-story/security/advisories/new).
If that link does not work, contact the maintainer through
[their GitHub profile](https://github.com/nirajgiriXD) and ask for a private channel,
without sharing the details in public.

Please include:

- What the problem is, and what an attacker could do with it.
- How to reproduce it: the command, the product file settings (no real secrets) and, if
  it involves a web page, a minimal page that triggers it.
- The commit you tested (`git rev-parse --short HEAD`), your operating system and
  Node.js version.

You will get a reply once the report has been read. Please give the maintainer a chance
to fix the problem before you talk about it in public. Reporters are credited in the fix,
unless they prefer not to be.

## What counts

These are in scope:

- **Secrets leaking.** Passwords, API keys or `env:` values showing up in logs, the
  database (`engine/data/app-story.db`), captions, narration or the video.
- **Getting around the safety guards.** The browser leaving the product's `url`, or doing
  a risky action (deleting, paying, sending email, publishing, changing account settings,
  inviting users) that the product file does not `allow`.
- **Prompt injection.** Text on a web page that makes the AI ignore AppStory's rules or
  its tool limits.
- **Running code or reading files** outside what AppStory is meant to touch, for example
  through a product file, a plan or a page that AppStory records.

These are out of scope:

- Problems in the web apps you record. Report those to the app's owner.
- Problems in third-party packages that AppStory does not make worse. Report those
  upstream; tell us too if AppStory should update or work around them.
- Someone who can already edit your `.env`, product files or the AppStory code.

## Using AppStory safely

- Point AppStory at a staging or demo copy of your app with made-up data, not at
  production.
- Use a demo account with only the permissions the videos need.
- Keep passwords in `.env` and refer to them as `env:NAME`. Never commit `.env`.
- Only `allow` risky actions that a video really needs.
- Watch a new video before you publish it, to check it shows nothing private.
