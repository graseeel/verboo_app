# Tauri Updater Signing

This document describes how the Tauri updater is configured to verify signed update packages for Verboo Code Desktop.

The updater configuration lives in `src-tauri/tauri.conf.json` under `plugins.updater`. The `pubkey` field contains the public key used to verify update signatures. The corresponding private key is kept **outside** the repository and is used only in CI to sign update bundles.

## Key material (local, never committed)

| File | Purpose | Permissions |
| --- | --- | --- |
| `$HOME/.tauri/verboo-updater.key` | Private key (used to sign updates) | `600` |
| `$HOME/.tauri/verboo-updater.key.pub` | Public key (mirrors `tauri.conf.json` `pubkey`) | `600` |
| `$HOME/.tauri/verboo-updater.pass` | Password protecting the private key | `600` |

All three files live under `$HOME/.tauri/`, which is outside the repository. They must never be copied into the project tree, committed, or printed in logs.

If the private key or password is lost, updates cannot be signed and a new keypair must be generated (see [Rotation](#rotation)).

## Public key in the repo

Only the public key is committed, in `src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/graseeel/verboo_app/releases/latest/download/latest.json"
    ],
    "pubkey": "<base64 public key>"
  }
}
```

The `pubkey` value is safe to commit — it is only used to verify signatures on the client side.

## CI secrets

The Tauri release workflow (`.github/workflows/tauri-release.yml`) signs update bundles during the `cargo tauri build` step. Configure the following repository secrets in GitHub:

| Secret name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of `$HOME/.tauri/verboo-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Full contents of `$HOME/.tauri/verboo-updater.pass` |

To configure them:

1. Open the repository on GitHub.
2. Go to `Settings` → `Secrets and variables` → `Actions`.
3. Click `New repository secret`.
4. Add `TAURI_SIGNING_PRIVATE_KEY` with the private key file contents.
5. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the password file contents.

The release workflow reads these environment variables and signs the update bundle automatically. Without both secrets, `cargo tauri build` produces an unsigned bundle and the updater will reject it on the client.

## How signing is invoked

`cargo tauri build` reads `TAURI_SIGNING_PRIVATE_KEY` (or `TAURI_SIGNING_PRIVATE_KEY_PATH`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from the environment. When present, it signs the generated `.app`/`.dmg`/`.exe`/`.AppImage` bundle and emits a `latest.json` manifest containing the signature. The updater client downloads the bundle, verifies the signature against `pubkey` in `tauri.conf.json`, and only then applies the update.

## Rotation

If the private key or password is compromised or lost:

1. Generate a new keypair:

   ```bash
   PASS="$(openssl rand -base64 32)"
   printf '%s' "$PASS" > "$HOME/.tauri/verboo-updater.pass"
   chmod 600 "$HOME/.tauri/verboo-updater.pass"
   npx tauri signer generate --ci --password "$PASS" \
     -w "$HOME/.tauri/verboo-updater.key" -f
   ```

2. Copy the new public key from `$HOME/.tauri/verboo-updater.key.pub` into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. Validate the JSON:

   ```bash
   node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json'))"
   ```

4. Update the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the new values.
5. Publish a new release. Clients on the old key will not be able to auto-update from the new key — they must reinstall once. Plan rotation around a release that ships the new `pubkey` before the old key is revoked.

## Security notes

- Never print the private key or password to logs, terminals, or commit messages.
- Never commit `$HOME/.tauri/` to the repository.
- The public key in `tauri.conf.json` is not sensitive — it is distributed to every client.
- If a CI runner needs the key, prefer `TAURI_SIGNING_PRIVATE_KEY` (env var) over `TAURI_SIGNING_PRIVATE_KEY_PATH` (file path), since the file path requires the key file to exist on the runner.
