# Managed Node runtime verification

Date: 2026-08-11

Branch: `dev`
Target validated locally: macOS arm64

## Outcome

Verboo no longer ships Node inside new desktop packages. On first authenticated use, the app downloads the exact Node runtime declared by the desktop build, verifies it, installs only `node` and `LICENSE` under app data, and prepares the signed Verboo CLI with that private runtime. It does not depend on a system Node installation or search `PATH`, npm, nvm, Homebrew, or another package manager.

The adjacent `verboo-node` resolver remains only as a compatibility path for older development packages. It is absent from the new `.app`, DMG, updater archive, and release resources.

## Trust and installation contract

- Node is pinned to `24.19.0`, modules ABI `137`, and N-API `10`.
- All four supported desktop targets are pinned to the official `https://nodejs.org/dist/v24.19.0/` release root with exact archive names, byte sizes, and SHA-256 digests.
- The four declared digests matched Node's official `SHASUMS256.txt`; the declared byte sizes matched the official response metadata.
- Downloads have a ten-minute wall timeout, bounded redirects, an exact byte limit, streaming SHA-256 verification, and a private staging directory.
- Extraction validates every archive path and materializes only the declared regular `node` executable and `LICENSE`. Declared symlinks, duplicate entries, traversal paths, unexpected types, oversized files, partial downloads, and hash mismatches fail closed.
- Activation is atomic. A receipt records the version, target, archive hash, executable hash, and ABI. Every resolution repeats the receipt, executable hash, permissions, and runtime smoke checks.
- Windows child creation uses the repository's no-window/process-group flags. The completeness guard now covers the managed-runtime smoke process.

## Packaged first-use behavior

The clean packaged `.app` was launched after moving the existing managed runtime to a recoverable temporary directory.

- At approximately `+5.95 s`, the runtime receipt had been committed after download, extraction, hashing, and ABI smoke validation.
- At approximately `+7.7 s`, the packaged UI showed the localized success state.
- The composer remained disabled until the success state completed, then became editable.
- The mounted App test separately exercised the whole visible state sequence: runtime preparation, CLI installation, disabled prompt submission, Settings navigation during preparation, retry, verified success, and unlock.
- A real Claude turn from the packaged app completed successfully using the newly created runtime.
- LaunchServices/Dock inspection during packaged-app use found no `verboo-node` registration.
- The app-created runtime was persisted at the versioned app-data location and passed an independent version/ABI smoke command.

The cold UI measurement reused an already installed CLI `0.15.12`, so the roughly six-second runtime preparation is a Node-only first-use observation on this network. A separate clean ignored E2E test downloaded and validated both official Node and signed CLI `0.15.13`; it passed in `62.75 s`, including test setup and both remote downloads.

## Package size comparison

Both packages below were built from the same `0.7.0-beta` workspace on macOS arm64. The baseline contains the 121,306,800-byte `verboo-node`; the new package does not.

| Artifact | Bundled Node baseline | Managed runtime | Reduction |
| --- | ---: | ---: | ---: |
| `.app` disk usage | 199,180 KiB | 80,840 KiB | 118,340 KiB (59.41%) |
| DMG | 73,110,436 B | 34,240,842 B | 38,869,594 B (53.17%) |
| updater `.app.tar.gz` | 75,051,619 B | 34,984,490 B | 40,067,129 B (53.39%) |

The macOS arm64 first-use download is 27,162,556 bytes. After extraction, the private runtime occupies 118,624 KiB. App plus installed runtime is therefore approximately the same final disk footprint as before (199,464 KiB versus 199,180 KiB); the material gains are installer/update size, download bandwidth for desktop releases, independent runtime lifecycle, and removal of the `verboo-node` app-bundle identity.

The final `.app` and updater archive contain no `node`, `node.exe`, `verboo-node*`, or Node release archive file. WebDriverAgent still contains two ordinary JavaScript source directories named `node` inside Axios; neither is an executable or a Node runtime.

## Warm performance comparison

The baseline and managed executables are byte-identical Node `v24.19.0` binaries (121,306,800 bytes, SHA-256 `27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1`). Commands were warmed and then alternated between paths to reduce ordering bias.

| Workload | Samples | Bundled median / p95 | Managed median / p95 | Managed median delta |
| --- | ---: | ---: | ---: | ---: |
| `node --version` | 20 each | 14.451 / 15.404 ms | 14.748 / 15.532 ms | +2.06% |
| CLI `--version` | 20 each | 248.512 / 254.000 ms | 247.086 / 252.811 ms | -0.57% |
| CLI `--list-models` | 5 each | 2,416.580 / 2,621.939 ms | 2,498.525 / 2,751.971 ms | +3.39% |

Median RSS was identical for raw Node (22,740,992 bytes), nearly identical for CLI version discovery (229,556,224 versus 229,507,072 bytes), and within 0.5% for the network-backed model query. Because the executables and CLI input are identical, the small timing differences are scheduler and network noise; moving the binary out of the app bundle introduces no persistent execution layer.

## Verification gates

- Rust library suite: 1,293 passed, 1 ignored.
- Renderer suite: 1,710 passed across 161 files.
- Renderer type-check and production build: passed.
- Managed Node focused suite: 21 passed.
- Update coordinator: 15 passed.
- CLI updater: 33 passed.
- Packaging/update ownership scripts: 5 passed.
- Release signing/notarization scripts: 9 passed.
- Update manifest scripts: 6 passed.
- Browser packaged-runtime checks: 18 passed.
- Tauri helper scripts (WDA, media, Chrome helper): 12 passed.
- Clean remote Node plus signed-CLI E2E: passed.
- `git diff --check`: passed.

The first full Rust run exposed a missing entry in the repository's process-spawn completeness list; the smoke process already applied the correct flags, and the list was corrected. An unrelated simulator timing test failed once under concurrent suite load, then passed three isolated runs and the complete rerun.

Native Windows and Linux compilation/package execution must be confirmed by the repository CI runners after push. Local cross-compilation was not treated as proof because this Mac lacks the Windows SDK headers and Linux GLib/sysroot required by the Tauri dependency graph. The shared contract and packaging guards are exercised locally, but only native CI can close that platform-specific build claim.
