# Verboo Code Runtime Requirements

This folder documents the runtime contract for the distributed Apple Silicon build.

The packaged app is designed to be self-contained. A user should not need Node.js,
npm, Homebrew, or a globally installed `@verboo/code` CLI to launch the app.

## Supported Target

- macOS 12.0 or newer.
- Apple Silicon arm64 only.
- MacBook Air M1 and newer are in scope for the current package.

## Required Inside The App Bundle

The Tauri bundle ships:

- The Rust backend (`src-tauri/`) compiled into the native binary.
- The system WebView (WKWebView on macOS) for the frontend — no bundled Chromium.
- The embedded `cli-package` (the Verboo CLI plus its Node dependency closure) under `src-tauri/resources/cli-package/`.
- The local terminal module through the Rust `portable-pty` crate (Tauri terminal sidecar).
- The local terminal UI through `@xterm/xterm`.
- Image/OCR support through `sharp` and `tesseract.js`.

## Optional User Tools

Git and Apple Command Line Tools are useful when the assistant works inside real
repositories, but they are not required for the app to open, authenticate, list
models, or start a normal conversation.

Do not install or downgrade user tools automatically. If the user already has a
newer compatible dependency, leave it intact.

## First Launch

On first launch per app version, the Rust backend validates:

- macOS platform.
- arm64 CPU architecture.
- minimum macOS version.
- embedded Verboo CLI availability (the `cli-package` resource is present and runnable on the system Node runtime).
- required bundled native packages.

Fatal failures show a blocking dialog and the app exits. Optional tool gaps are
warnings only.

## Manual Preflight

For internal unsigned builds, run:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"
```

To remove quarantine from an internal build that you trust:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app" --clear-quarantine
```

For public distribution, the right fix is Developer ID signing and notarization,
not asking users to clear quarantine manually.
