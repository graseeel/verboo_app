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
- Includes a local terminal side panel for project commands.
- Includes a feedback/report-bug flow backed by Supabase, with `mailto:` fallback.

## Requirements

- macOS 12.0 or newer.
- Apple Silicon arm64 Mac. The current package targets MacBook Air M1 and newer.
- Internet access and a valid Verboo session or API key.

The packaged app is self-contained for normal use. It includes the Electron
runtime, the embedded `@verboo/code` CLI, the local terminal module, and the
image/OCR dependencies it needs to start.

Node.js, npm, Homebrew, and a global `@verboo/code` CLI are not required to run
the packaged app. If the user already has newer compatible versions of those
tools, the app leaves them untouched.

Git and Apple Command Line Tools are optional, but useful when the assistant
works inside a real repository:

```bash
git --version
xcode-select -p
```

On first launch per app version, Verboo Code runs a requirements check. It
blocks only fatal package/platform problems: non-macOS, non-arm64, unsupported
macOS version, missing embedded CLI, or missing bundled native modules. Optional
tools such as Git are warnings only.

See [requirements/README.md](requirements/README.md) for the full runtime
contract.

### Internal Unsigned Builds

Unsigned/ad-hoc builds are for internal testing. They can be blocked by
Gatekeeper on another Mac with messages such as "damaged" or "cannot verify the
developer". For public distribution, use Developer ID signing and notarization.

For an internal build that you trust, you can run the preflight script:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"
```

If macOS quarantine is blocking a trusted internal build:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app" --clear-quarantine
```

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
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package
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
