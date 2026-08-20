use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};

/// Sends an interrupt signal (SIGINT on Unix, Ctrl+C on Windows) to a child
/// process AND its entire process group (subagents/forks inclusos).
///
/// On Unix, signals the process GROUP (`kill(-pid, SIGINT)`) so that
/// subagents forked by the CLI die together — not just the direct child.
/// This requires the child to have been spawned with
/// `configure_process_group` (so `pid == pgid`). If the child was NOT
/// spawned with `setpgid`, `kill(-pid, ...)` returns ESRCH and we fall
/// back to `kill(pid, SIGINT)` (direct child only).
///
/// On Windows, the child must have been created with
/// `CREATE_NEW_PROCESS_GROUP` so `GenerateConsoleCtrlEvent` can target its
/// group. If it wasn't, we fall back to `TerminateProcess`.
pub fn interrupt_child(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        if pid > 0 {
            // signal_process_tree tries the process GROUP first
            // (`kill(-pid, SIGINT)`), then falls back to the direct
            // child (`kill(pid, SIGINT)`) if the group signal failed
            // (ESRCH — child not a group leader). See the helper's
            // doc comment for the full rationale.
            if unsafe { signal_process_tree(pid, libc::SIGINT) } {
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

/// Hard-kills the child's entire process group (SIGKILL to the group on
/// Unix; `child.kill()` on Windows). Use as the escalation fallback after
/// `interrupt_child` didn't produce an exit within the graceful window.
///
/// On Unix, tries `kill(-pid, SIGKILL)` (group) first; if that fails
/// (ESRCH — child not a group leader), falls back to `child.kill()`
/// (direct child). Same safety net as `interrupt_child` /
/// `interrupt_child_until` — a child spawned without
/// `configure_process_group` still gets killed (direct child), just not
/// its subagents.
pub fn terminate_process_group(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        if pid > 0 {
            if unsafe { signal_process_tree(pid, libc::SIGKILL) } {
                return Ok(());
            }
        }
    }

    child
        .kill()
        .map_err(|e| format!("Falha ao finalizar processo: {e}"))
}

/// Signals the child's process tree: tries the process GROUP
/// (`kill(-pid, sig)`) first, then falls back to the direct child
/// (`kill(pid, sig)`) if the group signal failed (ESRCH — child not a
/// group leader, or group already gone). Returns true if either
/// succeeded.
///
/// This is the safety net that makes `interrupt_child`,
/// `interrupt_child_until`, and `terminate_process_group` work for
/// children spawned WITHOUT `configure_process_group` (no setpgid) —
/// they still receive the signal (direct child), just not their
/// subagents. Without this net, `kill(-pid, ...)` is a silent no-op
/// and the child survives the entire escalation until the final
/// `child.kill()` (SIGKILL only, no graceful window).
#[cfg(unix)]
unsafe fn signal_process_tree(pid: libc::pid_t, sig: libc::c_int) -> bool {
    if libc::kill(-pid, sig) == 0 {
        return true;
    }
    libc::kill(pid, sig) == 0
}

#[cfg(unix)]
pub fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
pub fn configure_process_group(_command: &mut Command) {}

pub fn interrupt_child_until(child: &mut Child, deadline: Instant) -> Result<(), String> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }

    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        if pid > 0 && Instant::now() < deadline {
            // Each signal tries the process GROUP first (`kill(-pid, ...)`),
            // then falls back to the direct child (`kill(pid, ...)`). A
            // child spawned WITHOUT `configure_process_group` (no setpgid)
            // is NOT a group leader → `kill(-pid, ...)` returns ESRCH →
            // the fallback delivers the signal to the direct child. Without
            // this fallback, all three signals are silent no-ops and the
            // child goes straight to `child.kill()` (SIGKILL) at the end —
            // no graceful window. (Maestro achado 2026-08-07: the old
            // `kill(-pid, ...)`-only code was asymmetric with
            // `interrupt_child` which DID fall back.)
            unsafe {
                let _ = signal_process_tree(pid, libc::SIGINT);
            }
            if wait_for_child_until(child, deadline) {
                return Ok(());
            }
            unsafe {
                let _ = signal_process_tree(pid, libc::SIGTERM);
            }
            if wait_for_child_until(child, deadline) {
                return Ok(());
            }
            unsafe {
                let _ = signal_process_tree(pid, libc::SIGKILL);
            }
        }
    }

    #[cfg(not(unix))]
    {
        let _ = interrupt_child(child);
        if wait_for_child_until(child, deadline) {
            return Ok(());
        }
    }

    child
        .kill()
        .map_err(|error| format!("Falha ao finalizar processo: {error}"))?;
    child
        .wait()
        .map(|_| ())
        .map_err(|error| format!("Falha ao aguardar processo: {error}"))
}

fn wait_for_child_until(child: &mut Child, deadline: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => return false,
        }
    }
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
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
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

    /// (c) Parar mata subagentes: `interrupt_child` must signal the
    /// process GROUP, not just the direct child. This test spawns a
    /// perl process that `fork`s a child (the grandchild / "subagent")
    /// and both sleep. perl does NOT do job control, so the forked
    /// child stays in the same process group as the parent — unlike
    /// `sh -c "sleep & wait"` where bash may put the backgrounded job
    /// in its own group. We make the perl parent a group leader (same
    /// as `configure_process_group` does for CliSpawn), then call
    /// `interrupt_child` and assert the WHOLE group is gone.
    ///
    /// Mutation: revert `interrupt_child` to `kill(pid, SIGINT)`
    /// (direct child only) → the forked grandchild survives →
    /// `kill(-pid, 0)` returns 0 → assertion `post == -1` FAILS.
    /// Named mutation:
    /// `interrupt_child_direct_only_lets_subagent_survive`.
    #[cfg(unix)]
    #[test]
    fn interrupt_child_kills_process_group_not_just_direct_child() {
        use std::os::unix::process::CommandExt;
        use std::process::Command;
        use std::time::Duration;

        // perl -e 'fork; sleep 30' — fork() returns child PID to
        // parent and 0 to child; BOTH fall through to `sleep 30`.
        // Neither does job control, so both stay in the same process
        // group. The parent is the "CLI child"; the forked child is
        // the "subagent".
        let mut cmd = Command::new("perl");
        cmd.arg("-e").arg("fork; sleep 30");
        unsafe {
            cmd.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("spawn perl");
        let pid = child.id() as libc::pid_t;
        assert!(pid > 0);

        // Give perl time to fork + both reach sleep.
        std::thread::sleep(Duration::from_millis(400));

        // Pre-condition: group has 2 members (perl parent + forked child).
        let pre = unsafe { libc::kill(-pid, 0) };
        assert_eq!(pre, 0, "group should exist before interrupt");

        interrupt_child(&mut child).expect("interrupt_child");
        child.wait().expect("wait perl");

        // Give the forked grandchild a moment to die from the group SIGINT.
        std::thread::sleep(Duration::from_millis(300));

        // Assert the WHOLE group is gone. If `interrupt_child` only
        // killed the direct child (perl parent), the forked grandchild
        // would still be alive → `kill(-pid, 0)` returns 0 → FAILS.
        let post = unsafe { libc::kill(-pid, 0) };
        assert_eq!(
            post, -1,
            "process group should be gone after interrupt_child; \
             if post==0 a subagent survived (direct-child-only mutation)"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
            "ESRCH expected (no such process group)"
        );
    }

    /// (c) Companion: `terminate_process_group` hard-kills the whole
    /// group with SIGKILL. Same forked-child pattern but the parent
    /// ignores SIGINT (`$SIG{INT} = 'IGNORE'`) so only SIGKILL can
    /// kill it — isolates the hard-kill path.
    #[cfg(unix)]
    #[test]
    fn terminate_process_group_kills_whole_tree() {
        use std::os::unix::process::CommandExt;
        use std::process::Command;
        use std::time::Duration;

        let mut cmd = Command::new("perl");
        cmd.arg("-e").arg("$SIG{INT}='IGNORE'; fork; sleep 30");
        unsafe {
            cmd.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("spawn perl");
        let pid = child.id() as libc::pid_t;
        std::thread::sleep(Duration::from_millis(400));

        terminate_process_group(&mut child).expect("terminate_process_group");
        child.wait().expect("wait perl");
        std::thread::sleep(Duration::from_millis(300));

        let post = unsafe { libc::kill(-pid, 0) };
        assert_eq!(
            post, -1,
            "group should be gone after terminate_process_group; \
             if post==0 a subagent survived the hard-kill"
        );
    }

    /// (c) Maestro achado 2026-08-07: `interrupt_child_until` must
    /// deliver the graceful escalation (SIGINT → SIGTERM → SIGKILL)
    /// even to a child spawned WITHOUT `setpgid` (no
    /// `configure_process_group`). The old code used `kill(-pid, ...)`
    /// for all three signals with NO fallback — for a non-group-leader
    /// child, all three were silent ESRCH no-ops and the child went
    /// straight to `child.kill()` (SIGKILL only, no graceful window).
    ///
    /// This test spawns perl WITHOUT setpgid. perl traps SIGINT and
    /// writes a marker file, then continues sleeping. If
    /// `interrupt_child_until` delivers SIGINT (via the
    /// `kill(pid, ...)` fallback), the marker file exists. If it
    /// doesn't (the old `kill(-pid, ...)`-only code), the marker is
    /// absent — perl went straight to SIGKILL.
    ///
    /// Mutation: revert `interrupt_child_until` to use bare
    /// `kill(-pid, ...)` (no `signal_process_tree` fallback) →
    /// SIGINT never reaches perl → marker file absent →
    /// `marker.exists()` FAILS. Named mutation:
    /// `interrupt_child_until_no_fallback_skips_graceful_escalation`.
    #[cfg(unix)]
    #[test]
    fn interrupt_child_until_delivers_sigint_to_child_without_setpgid() {
        use std::process::Command;
        use std::time::{Duration, Instant};

        let test_dir = tempfile::tempdir().expect("create signal test directory");
        let marker = test_dir.path().join("sigint-delivered");
        let ready = test_dir.path().join("handler-ready");

        // perl traps SIGINT, writes marker, continues sleeping.
        // NO setpgid — the child is NOT a group leader, so
        // `kill(-pid, ...)` returns ESRCH. The fallback `kill(pid,
        // ...)` is the only way SIGINT reaches perl.
        let perl_code = "$SIG{INT}=sub{open(F,'>',$ARGV[0]) or die $!;close F}; \
                         open(R,'>',$ARGV[1]) or die $!;close R;sleep 10";
        let mut child = Command::new("perl")
            .arg("-e")
            .arg(perl_code)
            .arg(&marker)
            .arg(&ready)
            .spawn()
            .expect("spawn perl");
        let ready_deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() && Instant::now() < ready_deadline {
            assert_eq!(
                child.try_wait().expect("poll perl readiness"),
                None,
                "perl exited before installing its SIGINT handler"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            ready.exists(),
            "perl did not confirm its SIGINT handler before the readiness deadline"
        );

        let deadline = Instant::now() + Duration::from_secs(3);
        interrupt_child_until(&mut child, deadline).expect("interrupt_child_until");
        child.wait().expect("wait perl");

        // Assert SIGINT was delivered (marker file exists). Without
        // the fallback, `kill(-pid, SIGINT)` is ESRCH → no SIGINT →
        // marker absent → FAILS.
        assert!(
            marker.exists(),
            "SIGINT must reach the child even without setpgid; \
             marker absent means the graceful escalation was skipped \
             (kill(-pid)-only no-fallback mutation)"
        );
    }

    /// (c) Companion: `terminate_process_group` kills the direct child
    /// even without setpgid (via `child.kill()` fallback). The
    /// grandchild (fork) survives because it's in the test's group,
    /// not the child's — but the direct child must die.
    #[cfg(unix)]
    #[test]
    fn terminate_process_group_kills_direct_child_without_setpgid() {
        use std::process::Command;
        use std::time::Duration;

        // NO setpgid — child is NOT a group leader.
        let mut child = Command::new("perl")
            .arg("-e")
            .arg("fork; sleep 30")
            .spawn()
            .expect("spawn perl");
        let pid = child.id() as libc::pid_t;
        std::thread::sleep(Duration::from_millis(400));

        terminate_process_group(&mut child).expect("terminate_process_group");
        // Direct child must be dead (reaped).
        child.wait().expect("wait perl");

        // The direct child's PID must be gone.
        let rc = unsafe { libc::kill(pid, 0) };
        assert_eq!(
            rc, -1,
            "direct child must be dead after terminate_process_group"
        );
    }

    /// A2 pin test: on Windows, BOTH `CREATE_NEW_PROCESS_GROUP` and
    /// `CREATE_NO_WINDOW` must be set. This test runs only on Windows
    /// (cfg-gated) so it actually verifies the real flags. If someone
    /// swaps one for the other, this test fails.
    #[cfg(windows)]
    #[test]
    fn a2_process_creation_flags_has_both_no_window_and_new_process_group() {
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
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
    // HONESTIDADE DOCUMENTAL: este teste é FORM-ONLY. Ele prova a
    // PRESENÇA do padrão (`apply_creation_flags` / `.creation_flags`)
    // no código de produção — NÃO prova que o código compila no
    // Windows. Prova de compilação é feita separadamente:
    //   - Local: `cargo xwin check --target x86_64-pc-windows-msvc`
    //     (reproduzível por qualquer desenvolvedor com cargo-xwin)
    //   - CI: job Windows do ci-verify (compila nativamente)
    // ler a saída verde do form-test como prova de compilação é o
    // falso conforto que este comentário impede. O gate certo compila
    // o código de verdade.
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
            "src/services/android_emulator/media.rs",
            "src/services/android_emulator/mod.rs",
            "src/services/android_emulator/requirements.rs",
            "src/services/android_emulator/session.rs",
            "src/services/android_emulator/sdk.rs",
            "src/services/android_emulator/setup.rs",
            "src/services/auth_token.rs",
            "src/services/chrome_integration/cli_mcp.rs",
            "src/services/chrome_integration/installer.rs",
            "src/services/cli_credentials.rs",
            "src/services/cli_service.rs",
            "src/services/cli_spawn.rs",
            "src/services/cli_update/archive.rs",
            "src/services/git_service.rs",
            "src/services/goal_evaluator.rs",
            "src/services/ios_simulator.rs",
            "src/services/ios_simulator/media.rs",
            "src/services/ios_simulator/setup.rs",
            "src/services/ios_simulator_mcp.rs",
            "src/services/node_runtime/archive.rs",
            "src/services/plugins_service.rs",
            "src/services/provider_accounts.rs",
            "src/services/provider_catalog.rs",
            "src/services/research_subagent_runner.rs",
            "src/services/turn_service.rs",
            "src/services/video/prepare.rs",
            "src/services/video/probe.rs",
            "src/services/video/router.rs",
            "src/services/vision_fallback_service.rs",
            "src/services/windows_git.rs",
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
            (
                "src/services/provider_login_pty.rs",
                "F4 PTY bridge spawns the CLI via portable_pty (never std::process::Command) — the PTY child is a session leader (process group) by construction and is killed via killpg; Windows CREATE_NEW_PROCESS_GROUP/CREATE_NO_WINDOW flags are inapplicable to PTY spawns",
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
                    if trimmed.contains("Command::new(") || trimmed.contains("TokioCommand::new(") {
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
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
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

        let known: std::collections::HashSet<&str> = FILES_WITH_SPAWNS.iter().copied().collect();
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
            let spawn_lines: Vec<(usize, &'static str)> = production_spawn_lines(&full_src);

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

                let has_flag =
                    window.contains("apply_creation_flags") || window.contains(".creation_flags(");

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
