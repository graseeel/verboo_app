# Managed Node Runtime Design

**Status:** Approved direction, pending implementation-plan review  
**Target:** Verboo Code `0.7.0-beta`, PR #68 (`dev` -> `main`)  
**Platforms:** macOS arm64/x64, Windows x64, Linux x64

## Context

Verboo Desktop currently bundles a pinned Node.js executable as the
`verboo-node` Tauri sidecar. This makes the app work on clean machines and
keeps the CLI on the exact Node ABI used to package and test it, but the
runtime dominates the app bundle:

- installed macOS app: approximately 194 MB;
- bundled `verboo-node`: approximately 115 MB;
- official compressed macOS Node archive: approximately 26 MB;
- compressed standalone binary in the current build: approximately 39 MB.

Version `0.7.0` has not been distributed. Public users remain on `0.6.2`, so
there is no installed public population that depends on the `0.7.0` embedded
sidecar. The final `0.7.0` package can therefore omit Node immediately without
shipping an intentionally oversized transition release.

The runtime must not fall back to a user-installed Node in production. The
desktop CLI payload requires Node `>=24.0.0 <25.0.0` with modules ABI `137` and
N-API `10`. PATH, Homebrew, nvm, fnm, Volta, Windows Store shims, and Linux
distribution packages cannot guarantee that contract. A production fallback
to them would restore the non-developer login and startup failures that the
embedded runtime solved.

## Decision

Move the pinned Node runtime from the application bundle to a private,
versioned runtime store under the operating-system application-data directory.
The Rust application downloads, verifies, installs, and owns this runtime.
Node remains independent from the signed Verboo CLI updater and never becomes
a global operating-system dependency.

The final runtime resolution order is:

1. paired `VERBOO_NODE_PATH` and `VERBOO_CLI_PATH` overrides in debug builds;
2. a fully validated managed Node runtime in app data;
3. a fully validated legacy embedded `verboo-node`, when present;
4. unavailable, which activates the first-run bootstrap gate.

The third entry is migration compatibility, not a production packaging
requirement. The `0.7.0` Tauri bundle no longer contains `verboo-node`.

## Alternatives considered

### Use the user's system Node

Rejected for production. GUI applications do not reliably inherit interactive
shell PATH configuration, version-manager paths can move, and a discovered
binary may be absent or ABI-incompatible after an unrelated user update.
Installing Node globally would also require platform-specific privileges and
could interfere with a user's development environment.

System Node remains useful only through the explicit debug override.

### Compile the CLI into a standalone executable

Rejected for this release. Node SEA and other packagers still carry a runtime,
offer limited size savings after installer compression, and create risk around
native modules, dynamic plugins, ESM loading, and child processes.

### Keep Node in every app installer

Rejected as the steady state. It provides deterministic offline startup but
forces every app update to redownload the runtime even when the Node contract
did not change.

## Runtime store

The managed runtime root is:

```text
{appData}/runtime/node/{version}/{target}/
  node[.exe]
  LICENSE
  receipt.json
```

`receipt.json` contains only non-secret integrity metadata:

```json
{
  "schemaVersion": 1,
  "version": "24.19.0",
  "target": "aarch64-apple-darwin",
  "archiveSha256": "...",
  "executableSha256": "...",
  "modules": "137",
  "napi": "10"
}
```

The existing target manifest remains the source of the official Node URL,
archive name, entry path, license path, and expected archive SHA-256. The
manifest is compiled into the signed app so network content cannot change the
trusted contract.

## Bootstrap flow

On startup, the backend checks for a valid managed runtime without blocking the
renderer:

1. If the managed runtime validates, configure the CLI runtime authority and
   continue existing CLI startup validation.
2. If it is absent or invalid, expose bootstrap-required state immediately.
3. The existing first-install gate starts preparation in the background while
   the user can open Settings.
4. Download the exact official target archive over HTTPS with redirect and
   response-size limits.
5. Verify the archive SHA-256 before extraction.
6. Extract only the declared Node executable and license into a private staging
   directory; reject absolute paths, traversal, links, devices, and unexpected
   entries.
7. Validate the executable contract by running it with a bounded timeout and
   checking version `24.19.0`, modules `137`, and N-API `10`.
8. Write the receipt and atomically rename the staging directory into place.
9. Configure the CLI runtime authority, bootstrap or validate the independently
   signed CLI, then release the composer.

CLI preparation begins only after Node is validated. This keeps bootstrap and
retry strictly staged: runtime first, CLI second. A partial runtime is never
selected.

## Error and retry behavior

- Network, checksum, extraction, permission, and smoke failures keep agent
  actions blocked but leave Settings available.
- The gate uses friendly bilingual copy describing the combined operation as
  preparing Verboo, with the current stage (`runtime` or `CLI`) and progress.
- Retry restarts the failed stage and reuses an already verified completed
  stage.
- A failed replacement never deletes the last known-good runtime.
- Existing chats, settings, credentials, and installed CLI versions are not
  modified by a runtime failure.
- Raw URLs, archive contents, command output, and filesystem internals are not
  rendered to users. Diagnostic logs use stable sanitized error codes.

## Updates and ownership

Node is owned by the desktop app:

- the app's signed manifest selects the Node contract;
- changing Node requires an app release and app-side review;
- the CLI updater reads the runtime contract but never installs, replaces, or
  removes Node;
- the app updater never modifies CLI payloads;
- unchanged managed runtimes survive app updates and are reused;
- obsolete runtime versions are removed only after the new runtime and CLI
  startup smoke both succeed and no process lease references the old version.

This preserves the existing independent CLI-update architecture.

## Packaging transition

The code supports both transition states:

1. **Compatibility state:** managed runtime is preferred; an existing embedded
   sidecar can bootstrap or serve as last-known-good fallback.
2. **Final package state:** `verboo-node` is removed from `externalBin`, signing
   steps, preflight requirements, and release artifact assertions.

Because no public `0.7.0` build exists, PR #68 lands in the final package state.
No public release containing the compatibility-state bundle is required.

## Process visibility

Moving the executable does not change normal runtime CPU or memory use. The CLI
still runs as a child process with piped standard streams and process-group
ownership.

- Windows keeps `CREATE_NO_WINDOW`; no console or taskbar entry may appear.
- Linux launches no graphical toolkit and creates no desktop entry or window.
- macOS launches the signed Node command directly. It must not register with
  LaunchServices as a regular application. A behavioral test records the
  executable path and application registration during a real turn.

The process may remain visible in Activity Monitor, Task Manager, or a Linux
process monitor. That is expected and is distinct from a Dock, taskbar, or
terminal window.

## Verification

### Functional

- Fresh app-data directory downloads and installs the exact target runtime.
- Interrupted and corrupt downloads leave no selectable partial runtime.
- Checksum mismatch, path traversal, wrong ABI, and smoke timeout fail closed.
- Retry succeeds without reinstalling an already valid runtime.
- Legacy embedded fallback is selected only when the managed runtime is absent.
- Production never selects Node from PATH or version managers.
- CLI bootstrap, update, login, model listing, and a real turn work through the
  managed runtime.

### Cross-platform

- macOS arm64 and x64 package contracts use official signed Node archives.
- Windows x64 preserves `CREATE_NO_WINDOW` and validates the ZIP safely.
- Linux x64 validates the official archive and executable permission.
- CI exercises target selection, hash validation, safe extraction, receipt
  validation, and package exclusion for all four desktop targets.

### Size

Record for the same source commit:

- app bundle installed size with and without embedded Node;
- DMG/NSIS/AppImage/deb/rpm artifact size where the current runner supports it;
- managed runtime archive download size;
- installed managed runtime size;
- percentage and absolute reduction.

The final macOS `.app` must contain no `Contents/MacOS/verboo-node` and no Node
archive payload.

### Performance

Measure at least 20 warm runs for both the current embedded runtime and the
managed runtime:

- Node process spawn plus `--version` completion;
- CLI model-list smoke completion;
- first-token latency of a controlled real turn when provider/network variance
  can be held comparable;
- CPU and resident-memory samples during the same CLI workload.

Report median and p95. Runtime location is accepted when the warm spawn/model
smoke regression is within 5% or within 10 ms, whichever allowance is larger.
Network model latency is reported separately and is not used to attribute a
runtime regression without repeated paired evidence.

## Acceptance criteria

1. The `0.7.0` installer contains no Node executable or archive.
2. A clean non-developer machine can prepare Verboo without preinstalled Node.
3. The exact Node/ABI contract is validated before any CLI process runs.
4. Runtime failure is recoverable and never corrupts a working CLI/runtime.
5. CLI and app update ownership remain independent.
6. Windows and Linux show no terminal or graphical child window.
7. A real macOS turn does not register the Node child as a Dock application.
8. Functional, size, and performance comparisons are attached to PR #68.
