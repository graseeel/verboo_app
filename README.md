# Verboo Code Desktop

Verboo Code Desktop is an independent desktop client for working with the Verboo Code CLI from a focused app interface. It wraps the CLI-oriented workflow with project navigation, chat history, model selection, skill selection, permission controls, profile views, feedback reporting, and a macOS-friendly desktop shell.

Official CLI upstream: [verbeux-ai/code](https://github.com/verbeux-ai/code).

## Independent Build Notice

This is not an official Verboo product.

This repository is an independent build created with authorization to work on a Verboo desktop experience, but it is not developed, maintained, reviewed, endorsed, or shipped by Verboo as an official desktop product. Verboo, Verboo Code, the Verboo mascot, and related brand assets remain the property of their respective owners.

Use this app as an experimental community/independent desktop build. Expect bugs, incomplete behavior, and implementation differences from the official Verboo CLI.

## What It Does

- Runs the local `@verboo/code` CLI from an Electron desktop app.
- Detects Verboo CLI authentication or a valid Verboo API key before unlocking the app.
- Lists models available to the authenticated Verboo account when possible.
- Supports model selection and per-model context-window configuration.
- Provides project and chat organization similar to coding-assistant desktop apps.
- Supports local skill discovery and multi-skill selection in the composer.
- Supports image attachment handling, including a vision-helper fallback path when the selected model does not support vision.
- Includes a draggable Verboo pet with command-driven visibility.
- Includes a feedback/report-bug flow backed by Supabase, with `mailto:` fallback.

## Requirements

- macOS for the current desktop build.
- Node.js and npm.
- Verboo Code CLI from the official upstream project:

```bash
npm i @verboo/code -g
verboo
```

You can authenticate through the CLI or configure a Verboo API key inside the app settings.

## Development

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

Package locally:

```bash
npm run package
```

## Feedback Backend

Feedback is sent to a Supabase Edge Function when configured:

```bash
VERBOO_FEEDBACK_ENDPOINT=https://YOUR_PROJECT.supabase.co/functions/v1/feedback
VERBOO_FEEDBACK_PUBLIC_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

If Supabase is unavailable or not configured, the app opens a prefilled email to the maintainer.

See [docs/feedback-supabase.md](docs/feedback-supabase.md).

## Security Notes

- Do not commit real Verboo API keys.
- Do not commit Supabase service-role keys.
- API keys saved in the app are encrypted locally with Electron `safeStorage`.
- Feedback diagnostics intentionally avoid sending full chat transcripts.
- Full-access mode can allow broad local machine access through the underlying CLI and should be treated as a high-trust mode.

## Open Source

The application code is released under the MIT License.

The license applies to this repository's source code. It does not grant ownership or unrestricted reuse rights over Verboo trademarks, service names, logos, mascot art, or other Verboo-owned brand assets unless the Verboo owner separately grants those rights.

See [docs/open-source-review.md](docs/open-source-review.md) for the current open-source readiness review.
