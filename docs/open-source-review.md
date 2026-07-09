# Open Source Readiness Review

Date: 2026-06-30

## Summary

The app can be published as an open-source repository if the following boundaries are respected:

- The application source code can be licensed under MIT.
- Secrets must remain outside the repository and outside distributed builds.
- Verboo brand assets and names require permission from the Verboo owner and should not be treated as automatically MIT-licensed.
- The README must clearly state that this is an independent, non-official build.
- The official Verboo Code CLI upstream is `verbeux-ai/code`; this repository is a separate desktop client around that CLI workflow.
- GitHub currently reports no detected SPDX license for `verbeux-ai/code` (`NOASSERTION`), so this repository's MIT license must not be described as applying to the upstream CLI.

## Current Status

| Area | Status | Notes |
| --- | --- | --- |
| Source license | Ready | MIT license added for app code. |
| Official-status disclaimer | Ready | README states this is independent and not official. |
| Secrets in source | Ready | No service-role key or real API key is committed. `.env.example` uses placeholders. |
| Supabase service role | Ready | Service-role usage is isolated to the Edge Function runtime via `ctx.supabaseAdmin`; no service-role key is shipped in the app. |
| User credentials | Ready | Verboo API keys are stored locally through the OS credential store (macOS Keychain, Windows DPAPI, Linux libsecret) via the Tauri keyring plugin. |
| Feedback diagnostics | Ready | Feedback payload avoids full chat transcript by default. |
| Generated artifacts | Ready | `node_modules`, `out`, `release`, `.DS_Store`, Supabase temp files, and root generated bundle are ignored. |
| Upstream relationship | Ready | README links to `verbeux-ai/code` as the official CLI upstream and keeps this app positioned as an independent desktop build. |
| Upstream license boundary | Ready | This repository licenses only its own desktop app code. It does not relicense the upstream CLI or Verboo brand assets. |
| Brand ownership | Needs explicit confirmation | Verboo marks, mascot, icons, and wordmark remain Verboo-owned unless separately licensed. |
| Code signing/notarization | Needs private setup | Apple signing certificates should not be committed. |

## Recommended Repository Policy

1. Keep `.env` files, API keys, Supabase service-role keys, Apple certificates, and provisioning profiles out of Git.
2. Use repository secrets in CI for signing and deployment.
3. Keep the independent-build disclaimer visible in README and inside the app.
4. Document that Verboo branding is used with permission but not relicensed under MIT unless the Verboo owner confirms that explicitly.
5. Accept bug reports publicly only when they do not contain private logs, API keys, or user data. Sensitive reports should go through the feedback form or direct email.

## Conclusion

This project is safe to publish as open source from a code and secret-management perspective after Supabase is configured with environment variables and after Verboo branding permission is confirmed in writing.
