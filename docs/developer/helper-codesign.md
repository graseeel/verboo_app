# Computer Use helper — codesign & notarize (macOS)

**Audience:** release engineers  
**Scope:** `computer-use-helper` sidecar shipped with Verboo Code  
**Never commit secrets.** Use env vars / CI secrets only.

## Why this matters

macOS TCC (Accessibility, Screen Recording) is **per binary / signing identity**.
- Ad-hoc / dev builds often show **computer-use-helper** as a separate Privacy row.
- Developer ID + notarized builds should share the app’s signing identity so users see a coherent product.

## Env vars (not in git)

| Variable | Purpose |
|----------|---------|
| `MACOS_CODESIGN_IDENTITY` | e.g. `Developer ID Application: …` |
| `MACOS_NOTARY_KEY_ID` | App Store Connect API key id |
| `MACOS_NOTARY_ISSUER` | Issuer UUID |
| `MACOS_NOTARY_KEY_PATH` | Path to `.p8` key file |

Copy `docs/developer/helper-codesign.env.example` locally; do not commit filled values.

## Scripts

```bash
# Ad-hoc (dev)
./scripts/tauri/sign-helper.sh --dev

# Release sign (requires MACOS_CODESIGN_IDENTITY)
./scripts/tauri/sign-helper.sh --release path/to/computer-use-helper

# Verify
./scripts/tauri/verify-helper-signature.sh path/to/computer-use-helper
```

## Release gate

Before shipping a **non-dev** channel build:

1. Helper binary present in app bundle (`externalBin` / Resources).
2. `verify-helper-signature.sh` exits 0 (not ad-hoc for release).
3. Notarize app **and** ensure helper is included in the notarized ticket.
4. Spot-check System Settings → Privacy: Accessibility + Screen Recording list expected rows.

## Honest TCC UX

Settings copy already distinguishes ad-hoc vs signed (Approach A). Do not claim a single TCC row when using ad-hoc signing.
