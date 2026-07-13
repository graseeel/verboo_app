# Computer Use P0 — Automated Gate Report

**Date:** 2026-07-13  
**Branch:** `feat/computer-use-p0`  
**Scope:** Automated only (no owner GUI smoke). Manual Notes smoke remains optional for humans.

## Commands

```bash
cd src-tauri && cargo test --lib services::session_manager -- --nocapture
cd src-tauri && cargo test --lib computer_use -- --nocapture
npx vitest run src/renderer/features/computer-use
```

## Coverage vs SEV-1 bar (test plan)

| Check | Automated status |
|-------|------------------|
| No action without ACTIVE session | Covered (`denies_when_no_session`, N4) |
| Hard-block System Settings | Covered |
| Self-test OFF blocks Verboo | Covered |
| Self-test entry defense-in-depth | Covered (P1a) |
| Silent cross-app bind denied | Covered (`bind_target_locks...`) |
| Goal-directed list-apps without target | Covered |
| OS TCC revoke fails closed | Covered (`denies_when_os_permissions_revoked`, P1b) |
| Audit fail-closed (no exit) | Covered (P2) |
| AccessMode full ≠ CU | Covered |
| Hotkey denylist | Helper-side (Swift) — not fully unit-tested in Rust |
| Emergency stop &lt;500ms | Requires live helper + OS — **manual / ignored smoke** |
| Real Notes read+click+type | `notes_read_smoke...` **#[ignore]** — needs macOS + perms |

## Residual risk

- Full red-team AX fixture suite (`verboo_test` hooks) not yet implemented.
- Live emergency-stop latency not measured in CI.
- Codesign of helper for non-dev channel is packaging (P6), not this report.

## Verdict for automated layer

**PASS** on unit/integration tests currently in-tree. **Not a full P0 ship exit gate** until ignored smoke + red-team fixtures land.
