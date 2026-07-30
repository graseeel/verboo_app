use std::process::Child;

/// Sends an interrupt signal (SIGINT on Unix, Ctrl+C on Windows) to a child
/// process. Falls back to `child.kill()` if signal delivery fails.
///
/// On Windows, the child must have been created with
/// `CREATE_NEW_PROCESS_GROUP` so `GenerateConsoleCtrlEvent` can target its
/// group. If it wasn't, we fall back to `TerminateProcess`.
pub fn interrupt_child(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        if pid > 0 {
            // SAFETY: kill(pid, SIGINT) is async-signal-safe for valid pid.
            let rc = unsafe { libc::kill(pid, libc::SIGINT) };
            if rc == 0 {
                return Ok(());
            }
        }
    }

    #[cfg(windows)]
    {
        // The child must have been spawned with CREATE_NEW_PROCESS_GROUP;
        // in that case the child's PID is also its process-group ID.
        let raw_pid = child.id();
        let rc = unsafe {
            windows_sys::Win32::System::Console::GenerateConsoleCtrlEvent(
                windows_sys::Win32::System::Console::CTRL_C_EVENT,
                raw_pid,
            )
        };
        if rc != 0 {
            return Ok(());
        }
    }

    child
        .kill()
        .map_err(|e| format!("Falha ao interromper processo: {e}"))
}

/// Returns the process creation flags required for interrupt AND console
/// suppression on Windows.
///
/// A2 (2026-07-29): the previous version returned ONLY
/// `CREATE_NEW_PROCESS_GROUP`. That flag lets `GenerateConsoleCtrlEvent`
/// target the child group with CTRL_C_EVENT (so `interrupt_child` works),
/// but it does NOT suppress the console window. On Windows, spawning a
/// console-mode child without `CREATE_NO_WINDOW` pops a visible terminal
/// for the lifetime of the child. Field report: the app opened ~3
/// terminal windows on startup (auth checks) and one terminal titled
/// "CLAUDE" (the CLI's own console — brand leak from a competitor name
/// in the window title of a Verboo user's screen).
///
/// Both flags are required and must not be swapped:
///   - `CREATE_NEW_PROCESS_GROUP` — enables interrupt via
///     `GenerateConsoleCtrlEvent`. Without it, `interrupt_child` falls
///     back to `TerminateProcess` (kills the CLI without graceful exit).
///   - `CREATE_NO_WINDOW` — suppresses the console window. Without it,
///     every CLI spawn pops a visible terminal.
///
/// The pin test below asserts BOTH bits are present so a future edit
/// can't accidentally drop one for the other.
#[cfg(windows)]
pub fn process_creation_flags() -> u32 {
    use windows_sys::Win32::System::Threading::{
        CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
    };
    CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn process_creation_flags() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_flags_zero_on_non_windows() {
        #[cfg(not(windows))]
        assert_eq!(process_creation_flags(), 0);
    }

    /// A2 pin test: on Windows, BOTH `CREATE_NEW_PROCESS_GROUP` and
    /// `CREATE_NO_WINDOW` must be set. This test runs only on Windows
    /// (cfg-gated) so it actually verifies the real flags. If someone
    /// swaps one for the other, this test fails.
    #[cfg(windows)]
    #[test]
    fn a2_process_creation_flags_has_both_no_window_and_new_process_group() {
        use windows_sys::Win32::System::Threading::{
            CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        };
        let flags = process_creation_flags();
        assert!(
            flags & CREATE_NEW_PROCESS_GROUP != 0,
            "A2: CREATE_NEW_PROCESS_GROUP must be set so interrupt_child works"
        );
        assert!(
            flags & CREATE_NO_WINDOW != 0,
            "A2: CREATE_NO_WINDOW must be set so the child doesn't pop a console window"
        );
    }

    /// A2 cross-platform pin: the helper exists and returns a u32 on
    /// every platform. On non-Windows it's 0 (no flags needed). This
    /// runs on all OSes so the contract is exercised in CI even where
    /// the Windows-specific bit isn't available.
    #[test]
    fn a2_process_creation_flags_returns_u32_on_all_platforms() {
        let flags = process_creation_flags();
        // On Windows the value is non-zero (both bits set); on non-Windows
        // it's 0. We just assert it's a u32 we can pass to Command.
        let _ = flags;
    }

    // ────── A2-FIX2 VARREDURA: every production spawn has creation_flags ──────
    //
    // This test FAILS when a future change adds a `Command::new(` (or
    // `TokioCommand::new(`, or `std::process::Command::new(`) in
    // production code without also calling `apply_creation_flags` or
    // `.creation_flags(...)` within the next ~40 lines. The two
    // approved escape hatches are:
    //
    //   1. `CliSpawn::new(...)` — flags are applied inside the
    //      constructor (`cli_spawn.rs::apply_creation_flags`). All 9
    //      CLI callers inherit automatically. The test accepts
    //      `CliSpawn::new(` as covered without requiring flags in the
    //      caller.
    //
    //   2. The file is listed in EXEMPT below with a one-line reason
    //      (e.g. `/usr/bin/security` is macOS-only — never runs on
    //      Windows, so flags are inapplicable).
    //
    // Runs on EVERY OS (the test itself is OS-agnostic; the
    // `#[cfg(windows)]` of the helper it documents is exercised by the
    // pin tests above).
    //
    // SCOPE GUARD: each file is sliced at its first `#[cfg(test)]`
    // marker before scanning. Without this, the test would scan its
    // OWN source (which mentions forbidden strings in assertion
    // messages and exempt lists) and self-detect, producing false
    // positives. This is the same lesson as G-C1 / wiring-test
    // self-detection.
    //
    // If you add a new spawn site:
    //   - Use `CliSpawn::new(...)` (preferred — single chokepoint).
    //   - Or call `cli_spawn::apply_creation_flags(&mut cmd)` after
    //     building your Command.
    //   - Or (only if Windows is irrelevant — e.g. macOS-only path)
    //     add the file to EXEMPT with a reason.
    #[test]
    fn a2_fix2_every_production_spawn_has_creation_flags() {
        // Files in src/services/ that contain spawn sites. Each entry
        // is relative to src-tauri/. Add a file here when you add a
        // production spawn to it.
        //
        // Order matters for stable diffs (alphabetical).
        const FILES_WITH_SPAWNS: &[&str] = &[
            "src/services/auth_token.rs",
            "src/services/chrome_integration/cli_mcp.rs",
            "src/services/chrome_integration/installer.rs",
            "src/services/cli_credentials.rs",
            "src/services/cli_service.rs",
            "src/services/cli_spawn.rs",
            "src/services/git_service.rs",
            "src/services/goal_evaluator.rs",
            "src/services/plugins_service.rs",
            "src/services/research_subagent_runner.rs",
            "src/services/turn_service.rs",
            "src/services/video/prepare.rs",
            "src/services/video/probe.rs",
            "src/services/video/router.rs",
            "src/services/vision_fallback_service.rs",
            "src/services/workspace_files_service.rs",
        ];

        // Files where `Command::new` is allowed without flags. Each
        // entry MUST have a one-line reason. New exemptions require a
        // written justification — do not add "because it was already
        // there" or "forgot to add flags".
        const EXEMPT: &[(&str, &str)] = &[
            (
                "src/services/cli_credentials.rs",
                "fn run_security (line ~331) spawns `/usr/bin/security` (macOS Keychain CLI) — macOS-only path, never runs on Windows, flags inapplicable",
            ),
        ];

        // ── ETAPA 1: COMPLETUDE ──
        //
        // A2-FIX3 (2026-07-29): a lista FILES_WITH_SPAWNS era mantida
        // à mão. Se alguém adicionasse `Command::new` num arquivo NOVO
        // que não está na lista, o teste passava em silêncio — exatamente
        // a classe de defeito que o QA persegue neste projeto (lista
        // comparada com lista, completude não se auto-força).
        //
        // Esta etapa varre `src/services/` recursivamente, encontra
        // todo .rs cujo código de PRODUÇÃO contenha `Command::new(` ou
        // `TokioCommand::new(`, e FALHA se algum não estiver em
        // FILES_WITH_SPAWNS nem em EXEMPT. Assim a lista deixa de ser
        // documentação e passa a ser contrato: arquivo novo com spawn
        // quebra a suite até alguém decidir conscientemente se cobre
        // ou isenta.
        //
        // Reusa a MESMA lógica de corte no #[cfg(test)] e exclusão de
        // comentário da etapa 2, para as duas concordarem. A função
        // helper `production_has_spawn` é a única fonte de verdade.
        fn production_has_spawn(full_src: &str) -> bool {
            !production_spawn_lines(full_src).is_empty()
        }

        /// Única fonte de verdade para "quais spawns existem em código
        /// de produção". Aplica o corte no `#[cfg(test)]` e a exclusão
        /// de linhas de comentário. As duas etapas (completude e
        /// varredura por arquivo) chamam esta função, então concordam
        /// por construção.
        fn production_spawn_lines(full_src: &str) -> Vec<(usize, &'static str)> {
            let production_src: &str = match full_src.find("#[cfg(test)]") {
                Some(idx) => &full_src[..idx],
                None => full_src,
            };
            production_src
                .lines()
                .enumerate()
                .filter_map(|(idx, line)| {
                    let trimmed = line.trim_start();
                    if trimmed.starts_with("//") {
                        return None;
                    }
                    if trimmed.contains("Command::new(")
                        || trimmed.contains("TokioCommand::new(")
                    {
                        Some((idx + 1, "Command::new("))
                    } else if trimmed.contains("CliSpawn::new(") {
                        Some((idx + 1, "CliSpawn::new("))
                    } else {
                        None
                    }
                })
                .collect()
        }

        fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect_rs_files(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    out.push(path);
                }
            }
        }

        let services_dir = std::path::Path::new("src/services");
        let mut all_rs: Vec<std::path::PathBuf> = Vec::new();
        collect_rs_files(services_dir, &mut all_rs);
        all_rs.sort();

        let known: std::collections::HashSet<&str> =
            FILES_WITH_SPAWNS.iter().copied().collect();
        let exempt_paths: std::collections::HashSet<&str> =
            EXEMPT.iter().map(|(p, _)| *p).collect();

        let mut unknown: Vec<String> = Vec::new();
        for abs_path in &all_rs {
            // Convert to src/services/... form for comparison.
            let rel = abs_path.to_string_lossy().replace('\\', "/");
            let full_src = match std::fs::read_to_string(abs_path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if !production_has_spawn(&full_src) {
                continue;
            }
            if known.contains(rel.as_str()) || exempt_paths.contains(rel.as_str()) {
                continue;
            }
            unknown.push(rel);
        }

        if !unknown.is_empty() {
            panic!(
                "A2-FIX3 varredura COMPLETUDE FAIL: os seguintes arquivos em \
                 src/services/ contêm `Command::new(` ou `TokioCommand::new(` \
                 em código de produção mas NÃO estão em FILES_WITH_SPAWNS nem \
                 em EXEMPT:\n  - {}\n\nIsso significa que existem spawn sites \
                 que nem a lista manual cobriu. Para cada arquivo, decida \
                 conscientemente: (a) adicionar a FILES_WITH_SPAWNS e \
                 garantir que o spawn tem apply_creation_flags, OU (b) \
                 adicionar a EXEMPT com razão escrita, OU (c) remover o \
                 spawn se for código morto. NÃO adicione calado — reporte \
                 ao Maestro para decidir.",
                unknown.join("\n  - ")
            );
        }

        // ── ETAPA 2: VARREDURA POR ARQUIVO ──
        for path in FILES_WITH_SPAWNS {
            let full_src = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("varredura: could not read {path}: {e}"));

            // Reusa o mesmo helper da etapa 1 — única fonte de verdade
            // para slice #[cfg(test)] + exclusão de comentário. As
            // duas etapas concordam por construção.
            let spawn_lines: Vec<(usize, &'static str)> =
                production_spawn_lines(&full_src);

            if spawn_lines.is_empty() {
                // File was added to FILES_WITH_SPAWNS but no spawn
                // sites found — file was refactored to remove them.
                // That's OK; the list serves as documentation of
                // "files that historically had spawns" so a future
                // re-add gets caught.
                continue;
            }

            // Re-slice production_src para a janela de 40 linhas (o
            // helper retorna apenas linha+tipo, não o texto).
            let production_src: &str = match full_src.find("#[cfg(test)]") {
                Some(idx) => &full_src[..idx],
                None => &full_src[..],
            };

            // Check if file is exempt.
            let exempt_reason = EXEMPT
                .iter()
                .find(|(p, _)| p == path)
                .map(|(_, reason)| *reason);

            for (line_no, kind) in &spawn_lines {
                if *kind == "CliSpawn::new(" {
                    // Single chokepoint — flags applied inside
                    // CliSpawn::new. Caller is automatically covered.
                    // No flag required in caller's source.
                    continue;
                }

                // Command::new — must have creation_flags nearby OR
                // be in an exempt file. "Nearby" = within the next
                // 40 lines of the spawn site (covers the typical
                // pattern of `let mut cmd = Command::new(...); ...;
                // cli_spawn::apply_creation_flags(&mut cmd);`).
                let start = line_no.saturating_sub(1);
                let end = (start + 40).min(production_src.lines().count());
                let window: String = production_src
                    .lines()
                    .skip(start)
                    .take(end - start)
                    .collect::<Vec<_>>()
                    .join("\n");

                let has_flag = window.contains("apply_creation_flags")
                    || window.contains(".creation_flags(");

                if !has_flag {
                    if let Some(reason) = exempt_reason {
                        // Whole file is exempt — every spawn in it
                        // inherits the exemption. But the exemption
                        // is a contract: if a NEW spawn in an exempt
                        // file changes the picture (e.g. stops being
                        // macOS-only), the exemption may no longer
                        // apply. The test still warns so a reviewer
                        // notices.
                        eprintln!(
                            "varredura WARN: {path}:{line_no} `{kind}` is in an \
                             exempt file. Reason: {reason}. If the spawn is no \
                             longer covered by that reason, remove the \
                             exemption and add apply_creation_flags."
                        );
                        continue;
                    }
                    panic!(
                        "A2-FIX2 varredura FAIL: {path}:{line_no} has `{kind}` \
                         without `apply_creation_flags` or `.creation_flags(` \
                         within 40 lines. On Windows this spawn will pop a \
                         visible console window (field report: 3+ terminals \
                         on startup + 1 'CLAUDE'-titled brand leak). Fix: \
                         call `cli_spawn::apply_creation_flags(&mut cmd)` \
                         immediately after building the Command, OR migrate \
                         to `CliSpawn::new(args)` (preferred — single \
                         chokepoint), OR add the file to EXEMPT with a \
                         written justification."
                    );
                }
            }
        }
    }
}
