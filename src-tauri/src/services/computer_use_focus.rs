use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::services::computer_use_spawn::ComputerUseSpawn;

const FOCUS_RESTORE_FILE_NAME: &str = "focus-restore.json";
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_millis(1_500);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);

fn lifecycle_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct FocusLease {
    session_id: String,
    pid: u32,
    generation: String,
}

impl FocusLease {
    fn validate(&self) -> Result<(), String> {
        validated_pid(self.pid)?;
        if self.session_id.trim().is_empty() {
            return Err("focus lease has an empty session id".into());
        }
        if self.generation.trim().is_empty() {
            return Err("focus lease has an empty generation".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
struct FocusProtocolEvent {
    event: String,
    generation: String,
    #[serde(default)]
    target_observed: bool,
    #[serde(default)]
    compact_layout_applied: bool,
    #[serde(default)]
    display_id: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FocusStartReceipt {
    pub target_observed: bool,
    pub compact_layout_applied: bool,
    pub display_id: Option<u32>,
}

type FocusLayoutCallback = Arc<dyn Fn(FocusStartReceipt) + Send + Sync>;

#[derive(Clone)]
struct ActiveFocusChild {
    lease: FocusLease,
    child: Arc<Mutex<Child>>,
    expected_stop: Arc<AtomicBool>,
}

fn active_child_slot() -> &'static Mutex<Option<ActiveFocusChild>> {
    static ACTIVE_CHILD: OnceLock<Mutex<Option<ActiveFocusChild>>> = OnceLock::new();
    ACTIVE_CHILD.get_or_init(|| Mutex::new(None))
}

pub(crate) fn set_expected_stop(expected_session_id: Option<&str>, expected: bool) {
    if let Ok(slot) = active_child_slot().lock() {
        if let Some(active) = slot.as_ref().filter(|active| {
            expected_session_id.is_none_or(|expected| active.lease.session_id == expected)
        }) {
            active.expected_stop.store(expected, Ordering::SeqCst);
        }
    }
}

fn active_child_for(lease: &FocusLease) -> Result<Option<ActiveFocusChild>, String> {
    let active = active_child_slot()
        .lock()
        .map_err(|_| "active focus child lock is poisoned".to_string())?;
    Ok(active
        .as_ref()
        .filter(|candidate| candidate.lease == *lease)
        .cloned())
}

fn register_active_child(active: ActiveFocusChild) -> Result<(), String> {
    let mut slot = active_child_slot()
        .lock()
        .map_err(|_| "active focus child lock is poisoned".to_string())?;
    if slot.is_some() {
        return Err("another focus helper is already owned by this process".into());
    }
    *slot = Some(active);
    Ok(())
}

fn clear_active_child_if_matches(lease: &FocusLease) -> Result<(), String> {
    let mut slot = active_child_slot()
        .lock()
        .map_err(|_| "active focus child lock is poisoned".to_string())?;
    if slot.as_ref().is_some_and(|active| active.lease == *lease) {
        *slot = None;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExistingLeaseDecision {
    Start,
    ReplaceSameSession(FocusLease),
    RecoverStale(FocusLease),
    RefuseLiveForeign { session_id: String, pid: u32 },
}

fn existing_lease_decision(
    lease: Option<&FocusLease>,
    requested_session_id: &str,
    process_is_alive: bool,
    locally_owned: bool,
) -> ExistingLeaseDecision {
    let Some(lease) = lease else {
        return ExistingLeaseDecision::Start;
    };
    if !process_is_alive {
        return ExistingLeaseDecision::RecoverStale(lease.clone());
    }
    if lease.session_id == requested_session_id && locally_owned {
        ExistingLeaseDecision::ReplaceSameSession(lease.clone())
    } else {
        ExistingLeaseDecision::RefuseLiveForeign {
            session_id: lease.session_id.clone(),
            pid: lease.pid,
        }
    }
}

fn runtime_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("no application data directory")?;
    Ok(base
        .join("ai.verboo.code.desktop")
        .join("computer-use-runtime"))
}

fn lease_path() -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join("focus.json"))
}

fn read_lease_at(path: &Path) -> Result<Option<FocusLease>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let lease: FocusLease =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            lease.validate()?;
            Ok(Some(lease))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn restore_path_for_capability(capability_path: &Path) -> Result<PathBuf, String> {
    capability_path
        .parent()
        .map(|parent| parent.join(FOCUS_RESTORE_FILE_NAME))
        .ok_or_else(|| "computer-use capability path has no parent directory".to_string())
}

fn default_restore_path() -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join(FOCUS_RESTORE_FILE_NAME))
}

fn write_lease_at(path: &Path, lease: &FocusLease) -> Result<(), String> {
    lease.validate()?;
    let dir = path.parent().ok_or("focus lease has no parent directory")?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }

    let bytes = serde_json::to_vec(lease).map_err(|error| error.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    temporary
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    temporary.flush().map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(path)
        .map_err(|error| error.error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    fs::File::open(dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn start<L>(
    session_id: &str,
    app: &str,
    capability_path: &Path,
    capability_token: &str,
    on_layout_status: L,
) -> Result<FocusStartReceipt, String>
where
    L: Fn(FocusStartReceipt) + Send + Sync + 'static,
{
    if capability_token.trim().is_empty() {
        return Err("focus HUD capability token is empty".into());
    }
    let _guard = lifecycle_lock()
        .lock()
        .map_err(|_| "focus lifecycle lock is poisoned".to_string())?;
    let lease_file = lease_path()?;
    let restore_file = restore_path_for_capability(capability_path)?;
    let existing = read_lease_at(&lease_file)?;
    let (existing_is_alive, existing_is_owned) = if let Some(lease) = existing.as_ref() {
        if let Some(active) = active_child_for(lease)? {
            (active_child_is_running(&active)?, true)
        } else {
            (process_is_alive(lease.pid)?, false)
        }
    } else {
        (false, false)
    };

    match existing_lease_decision(
        existing.as_ref(),
        session_id,
        existing_is_alive,
        existing_is_owned,
    ) {
        ExistingLeaseDecision::Start => {
            restore_stale_state_at(&restore_file)?;
        }
        ExistingLeaseDecision::ReplaceSameSession(lease) => {
            stop_lease_at(&lease, &lease_file, &restore_file)?;
        }
        ExistingLeaseDecision::RecoverStale(lease) => {
            clear_active_child_if_matches(&lease)?;
            remove_lease_if_matches(&lease_file, &lease)?;
            restore_stale_state_at(&restore_file)?;
        }
        ExistingLeaseDecision::RefuseLiveForeign { session_id, pid } => {
            return Err(format!(
                "focus HUD is owned by live session {session_id} (pid {pid}); refusing replacement"
            ));
        }
    }

    let generation = uuid::Uuid::new_v4().to_string();
    let mut spawn = ComputerUseSpawn::new();
    spawn
        .command
        .arg("--focus-session")
        .arg(app)
        .arg(capability_path)
        .arg("--focus-generation")
        .arg(&generation)
        .env("VERBOO_CU_CAPABILITY_FILE", capability_path)
        .env("VERBOO_CU_TOKEN", capability_token)
        .env("VERBOO_CU_SESSION_ID", session_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn
        .command
        .spawn()
        .map_err(|e| format!("start focus HUD: {e}"))?;
    let Some(mut stdin) = child.stdin.take() else {
        let termination = terminate_child_and_wait(&mut child).err();
        let restoration = restore_stale_state_at(&restore_file).err();
        return Err(format_cleanup_errors(
            "focus HUD has no stdin".into(),
            termination,
            restoration,
        ));
    };
    let Some(stdout) = child.stdout.take() else {
        let termination = terminate_child_and_wait(&mut child).err();
        let restoration = restore_stale_state_at(&restore_file).err();
        return Err(format_cleanup_errors(
            "focus HUD has no stdout".into(),
            termination,
            restoration,
        ));
    };
    let mut reader = BufReader::new(stdout);
    if let Err(error) = read_focus_protocol_event(&mut reader, "focus-prepared", &generation) {
        let termination = terminate_child_and_wait(&mut child).err();
        let restoration = restore_stale_state_at(&restore_file).err();
        let stderr = child
            .stderr
            .take()
            .and_then(|mut stream| {
                let mut value = String::new();
                stream.read_to_string(&mut value).ok().map(|_| value)
            })
            .unwrap_or_default();
        let primary = if stderr.trim().is_empty() {
            error
        } else {
            format!("{error}: {}", stderr.trim())
        };
        return Err(format_cleanup_errors(primary, termination, restoration));
    }

    let lease = FocusLease {
        session_id: session_id.to_string(),
        pid: child.id(),
        generation,
    };
    if let Err(error) = lease.validate() {
        let termination = terminate_child_and_wait(&mut child).err();
        let restoration = restore_stale_state_at(&restore_file).err();
        return Err(format_cleanup_errors(error, termination, restoration));
    }
    let active = ActiveFocusChild {
        lease: lease.clone(),
        child: Arc::new(Mutex::new(child)),
        expected_stop: Arc::new(AtomicBool::new(false)),
    };
    if let Err(error) = register_active_child(active.clone()) {
        let termination = terminate_active_child_and_wait(&active).err();
        let restoration = restore_stale_state_at(&restore_file).err();
        return Err(format_cleanup_errors(error, termination, restoration));
    }

    if let Err(error) = write_lease_at(&lease_file, &lease) {
        return Err(cleanup_active_start_failure(
            format!("persist focus lease: {error}"),
            &active,
            &lease_file,
            &restore_file,
        ));
    }

    let commit = match serde_json::to_vec(&serde_json::json!({
        "event": "focus-commit",
        "generation": &lease.generation,
    })) {
        Ok(commit) => commit,
        Err(error) => {
            return Err(cleanup_active_start_failure(
                format!("encode focus commit: {error}"),
                &active,
                &lease_file,
                &restore_file,
            ));
        }
    };
    if let Err(error) = stdin
        .write_all(&commit)
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
    {
        drop(stdin);
        return Err(cleanup_active_start_failure(
            format!("commit focus lease to helper: {error}"),
            &active,
            &lease_file,
            &restore_file,
        ));
    }
    drop(stdin);

    let ready = read_focus_protocol_event(&mut reader, "focus-ready", &lease.generation).map_err(
        |error| cleanup_active_start_failure(error, &active, &lease_file, &restore_file),
    )?;

    let receipt = FocusStartReceipt {
        target_observed: ready.target_observed,
        compact_layout_applied: ready.compact_layout_applied,
        display_id: ready.display_id,
    };
    spawn_focus_layout_reader(reader, lease.generation.clone(), Arc::new(on_layout_status));
    spawn_active_child_watcher(active, lease_file, restore_file);
    Ok(receipt)
}

pub fn stop(expected_session_id: &str) -> Result<bool, String> {
    let _guard = lifecycle_lock()
        .lock()
        .map_err(|_| "focus lifecycle lock is poisoned".to_string())?;
    let lease_file = lease_path()?;
    let restore_file = default_restore_path()?;
    let Some(lease) = read_lease_at(&lease_file)? else {
        restore_stale_state_at(&restore_file)?;
        return Ok(true);
    };
    if lease.session_id != expected_session_id {
        return Ok(false);
    }
    refuse_unowned_live_lease(&lease)?;
    stop_lease_at(&lease, &lease_file, &restore_file)?;
    Ok(true)
}

pub fn stop_any() -> Result<(), String> {
    let _guard = lifecycle_lock()
        .lock()
        .map_err(|_| "focus lifecycle lock is poisoned".to_string())?;
    let lease_file = lease_path()?;
    let restore_file = default_restore_path()?;
    if let Some(lease) = read_lease_at(&lease_file)? {
        refuse_unowned_live_lease(&lease)?;
        stop_lease_at(&lease, &lease_file, &restore_file)?;
    } else {
        restore_stale_state_at(&restore_file)?;
    }
    Ok(())
}

/// Restores windows left minimized by a helper that exited before cleanup.
/// Missing state is a successful no-op; malformed or unresolved state fails
/// closed and is kept on disk for a later recovery attempt.
pub fn restore_stale_state() -> Result<bool, String> {
    let _guard = lifecycle_lock()
        .lock()
        .map_err(|_| "focus lifecycle lock is poisoned".to_string())?;
    let lease_file = lease_path()?;
    if let Some(lease) = read_lease_at(&lease_file)? {
        refuse_unowned_live_lease(&lease)?;
        if lease_is_running(&lease)? {
            return Err(format!(
                "refusing stale restoration while focus owner generation {} is live",
                lease.generation
            ));
        }
        clear_active_child_if_matches(&lease)?;
        remove_lease_if_matches(&lease_file, &lease)?;
    }
    restore_stale_state_at(&default_restore_path()?)
}

fn restore_stale_state_at(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let mut spawn = ComputerUseSpawn::new();
    let output = spawn
        .command
        .arg("--restore-focus-state")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("start focus restoration: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "focus restoration failed with status {} and state was preserved",
                output.status
            )
        } else {
            format!("focus restoration failed: {stderr}")
        });
    }
    if path.exists() {
        return Err("focus restoration reported success but left recovery state on disk".into());
    }
    Ok(true)
}

fn stop_lease_at(lease: &FocusLease, lease_file: &Path, restore_file: &Path) -> Result<(), String> {
    if let Some(active) = active_child_for(lease)? {
        terminate_active_child_and_wait(&active)?;
        clear_active_child_if_matches(lease)?;
    } else if process_is_alive(lease.pid)? {
        return Err(format!(
            "refusing to stop live foreign focus owner for session {} generation {}",
            lease.session_id, lease.generation
        ));
    }
    remove_lease_if_matches(lease_file, lease)?;
    restore_stale_state_at(restore_file)?;
    Ok(())
}

fn terminate_child_and_wait(child: &mut Child) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| format!("inspect focus HUD: {error}"))?
        .is_some()
    {
        return Ok(());
    }

    #[cfg(unix)]
    {
        let pid = validated_pid(child.id())?;
        let result = unsafe { libc::kill(pid, libc::SIGTERM) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("stop focus HUD: {error}"));
            }
        }
        let deadline = Instant::now() + GRACEFUL_STOP_TIMEOUT;
        loop {
            if child
                .try_wait()
                .map_err(|error| format!("wait for focus HUD: {error}"))?
                .is_some()
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(PROCESS_POLL_INTERVAL);
        }
    }

    child
        .kill()
        .map_err(|error| format!("force stop focus HUD: {error}"))?;
    child
        .wait()
        .map_err(|error| format!("reap focus HUD: {error}"))?;
    Ok(())
}

fn terminate_active_child_and_wait(active: &ActiveFocusChild) -> Result<(), String> {
    active.expected_stop.store(true, Ordering::SeqCst);
    {
        let mut child = active
            .child
            .lock()
            .map_err(|_| "focus child lock is poisoned".to_string())?;
        if child.id() != active.lease.pid {
            return Err("active focus child identity no longer matches its lease".into());
        }
        if child
            .try_wait()
            .map_err(|error| format!("inspect focus HUD: {error}"))?
            .is_some()
        {
            return Ok(());
        }
        #[cfg(unix)]
        {
            let pid = validated_pid(child.id())?;
            let result = unsafe { libc::kill(pid, libc::SIGTERM) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(format!("stop focus HUD: {error}"));
                }
            }
        }
    }

    if wait_for_active_child_exit(active, GRACEFUL_STOP_TIMEOUT)? {
        return Ok(());
    }

    let mut child = active
        .child
        .lock()
        .map_err(|_| "focus child lock is poisoned".to_string())?;
    if child.id() != active.lease.pid {
        return Err("active focus child identity changed before force stop".into());
    }
    if child
        .try_wait()
        .map_err(|error| format!("inspect focus HUD before force stop: {error}"))?
        .is_none()
    {
        child
            .kill()
            .map_err(|error| format!("force stop focus HUD: {error}"))?;
        child
            .wait()
            .map_err(|error| format!("reap focus HUD: {error}"))?;
    }
    Ok(())
}

fn wait_for_active_child_exit(
    active: &ActiveFocusChild,
    timeout: Duration,
) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let exited = {
            let mut child = active
                .child
                .lock()
                .map_err(|_| "focus child lock is poisoned".to_string())?;
            if child.id() != active.lease.pid {
                return Err("active focus child identity changed while waiting".into());
            }
            child
                .try_wait()
                .map_err(|error| format!("wait for focus HUD: {error}"))?
                .is_some()
        };
        if exited {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn active_child_is_running(active: &ActiveFocusChild) -> Result<bool, String> {
    let mut child = active
        .child
        .lock()
        .map_err(|_| "focus child lock is poisoned".to_string())?;
    if child.id() != active.lease.pid {
        return Err("active focus child identity no longer matches its lease".into());
    }
    Ok(child
        .try_wait()
        .map_err(|error| format!("inspect focus HUD: {error}"))?
        .is_none())
}

fn lease_is_running(lease: &FocusLease) -> Result<bool, String> {
    if let Some(active) = active_child_for(lease)? {
        active_child_is_running(&active)
    } else {
        process_is_alive(lease.pid)
    }
}

fn refuse_unowned_live_lease(lease: &FocusLease) -> Result<(), String> {
    if active_child_for(lease)?.is_none() && process_is_alive(lease.pid)? {
        return Err(format!(
            "refusing unscoped stop of live foreign focus owner for session {} generation {}",
            lease.session_id, lease.generation
        ));
    }
    Ok(())
}

fn validated_pid(pid: u32) -> Result<i32, String> {
    let pid = i32::try_from(pid).map_err(|_| "focus lease PID is outside the safe range")?;
    if pid <= 1 {
        return Err("focus lease PID must be greater than 1".into());
    }
    Ok(pid)
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> Result<bool, String> {
    let pid = validated_pid(pid)?;
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        Ok(true)
    } else {
        Ok(std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
}

#[cfg(not(unix))]
fn process_is_alive(pid: u32) -> Result<bool, String> {
    validated_pid(pid)?;
    Ok(false)
}

fn read_focus_protocol_event(
    reader: &mut BufReader<impl Read>,
    expected_event: &str,
    expected_generation: &str,
) -> Result<FocusProtocolEvent, String> {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("read focus HUD protocol: {error}"))?;
    if line.trim().is_empty() {
        return Err(format!(
            "focus HUD exited before {expected_event} generation {expected_generation}"
        ));
    }
    let event: FocusProtocolEvent = serde_json::from_str(&line)
        .map_err(|error| format!("decode focus HUD protocol: {error}"))?;
    if event.event != expected_event || event.generation != expected_generation {
        return Err(format!(
            "focus HUD protocol mismatch: expected {expected_event} generation {expected_generation}"
        ));
    }
    Ok(event)
}

fn spawn_focus_layout_reader<R>(
    mut reader: BufReader<R>,
    expected_generation: String,
    on_layout_status: FocusLayoutCallback,
) where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) => {
                eprintln!("[computer-use-focus] read layout status: {error}");
                return;
            }
        }
        let Ok(event) = serde_json::from_str::<FocusProtocolEvent>(&line) else {
            eprintln!("[computer-use-focus] ignored malformed layout status");
            continue;
        };
        if let Some(receipt) = focus_layout_receipt(event, &expected_generation) {
            on_layout_status(receipt);
        }
    });
}

fn focus_layout_receipt(
    event: FocusProtocolEvent,
    expected_generation: &str,
) -> Option<FocusStartReceipt> {
    (event.event == "focus-layout"
        && event.generation == expected_generation
        && event.target_observed)
        .then_some(FocusStartReceipt {
            target_observed: true,
            compact_layout_applied: event.compact_layout_applied,
            display_id: event.display_id,
        })
}

fn cleanup_active_start_failure(
    primary: String,
    active: &ActiveFocusChild,
    lease_file: &Path,
    restore_file: &Path,
) -> String {
    if let Err(error) = terminate_active_child_and_wait(active) {
        // Never discard the only strong process identity or its durable lease
        // while the isolating helper may still be alive. The watcher retains
        // ownership and performs exact-generation cleanup once exit is
        // positively observed.
        spawn_active_child_watcher(
            active.clone(),
            lease_file.to_path_buf(),
            restore_file.to_path_buf(),
        );
        return format!(
            "{primary}; termination failed: {error}; active ownership and lease retained for deferred cleanup"
        );
    }
    let clear = clear_active_child_if_matches(&active.lease).err();
    let lease_removal = remove_lease_if_matches(lease_file, &active.lease).err();
    let restoration = restore_stale_state_at(restore_file).err();
    let mut details = Vec::new();
    if let Some(error) = clear {
        details.push(format!("active-owner cleanup failed: {error}"));
    }
    if let Some(error) = lease_removal {
        details.push(format!("lease cleanup failed: {error}"));
    }
    if let Some(error) = restoration {
        details.push(format!("restoration failed: {error}"));
    }
    if details.is_empty() {
        primary
    } else {
        format!("{primary}; {}", details.join("; "))
    }
}

fn format_cleanup_errors(
    primary: String,
    termination: Option<String>,
    restoration: Option<String>,
) -> String {
    let mut details = Vec::new();
    if let Some(error) = termination {
        details.push(format!("termination failed: {error}"));
    }
    if let Some(error) = restoration {
        details.push(format!("restoration failed: {error}"));
    }
    if details.is_empty() {
        primary
    } else {
        format!("{primary}; {}", details.join("; "))
    }
}

fn spawn_active_child_watcher(
    active: ActiveFocusChild,
    lease_file: PathBuf,
    restore_file: PathBuf,
) {
    std::thread::spawn(move || {
        loop {
            match active_child_is_running(&active) {
                Ok(false) => break,
                Ok(true) => std::thread::sleep(PROCESS_POLL_INTERVAL),
                Err(error) => {
                    eprintln!("[computer-use-focus] focus HUD watcher failed: {error}");
                    if !active.expected_stop.load(Ordering::SeqCst) {
                        crate::services::computer_use_mcp::handle_unexpected_focus_exit(
                            &active.lease.session_id,
                        );
                    }
                    return;
                }
            }
        }
        finalize_active_child_exit(&active, &lease_file, &restore_file, |session_id| {
            crate::services::computer_use_mcp::handle_unexpected_focus_exit(session_id);
        });
    });
}

fn finalize_active_child_exit(
    active: &ActiveFocusChild,
    lease_file: &Path,
    restore_file: &Path,
    on_unexpected_exit: impl FnOnce(&str),
) {
    let expected_stop = active.expected_stop.load(Ordering::SeqCst);
    let should_report = match lifecycle_lock().lock() {
        Ok(_guard) => {
            if let Err(error) = clear_active_child_if_matches(&active.lease) {
                eprintln!("[computer-use-focus] clear exited HUD ownership: {error}");
            }
            match remove_lease_if_matches(lease_file, &active.lease) {
                Ok(true) => {
                    if let Err(error) = restore_stale_state_at(restore_file) {
                        eprintln!(
                            "[computer-use-focus] restore after unexpected HUD exit: {error}"
                        );
                    }
                    !expected_stop
                }
                Ok(false) => false,
                Err(error) => {
                    eprintln!("[computer-use-focus] clean exited HUD lease: {error}");
                    !expected_stop && !error.contains("lease changed while stopping its owner")
                }
            }
        }
        Err(_) => {
            eprintln!("[computer-use-focus] focus lifecycle lock is poisoned after HUD exit");
            !expected_stop
        }
    };
    if should_report {
        on_unexpected_exit(&active.lease.session_id);
    }
}

fn remove_lease_if_matches(path: &Path, expected: &FocusLease) -> Result<bool, String> {
    let Some(actual) = read_lease_at(path)? else {
        return Ok(false);
    };
    if actual != *expected {
        return Err("focus lease changed while stopping its owner".into());
    }
    remove_file_if_exists(path)?;
    Ok(true)
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn lease(session_id: &str, pid: u32, generation: &str) -> FocusLease {
        FocusLease {
            session_id: session_id.into(),
            pid,
            generation: generation.into(),
        }
    }

    #[cfg(unix)]
    fn exited_focus_child(
        session_id: &str,
        generation: &str,
        expected_stop: bool,
    ) -> ActiveFocusChild {
        use std::sync::atomic::AtomicBool;

        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("exit 17")
            .spawn()
            .unwrap();
        child.wait().unwrap();
        ActiveFocusChild {
            lease: lease(session_id, child.id(), generation),
            child: Arc::new(Mutex::new(child)),
            expected_stop: Arc::new(AtomicBool::new(expected_stop)),
        }
    }

    #[cfg(unix)]
    #[test]
    fn unexpected_focus_hud_exit_cleans_lease_then_reports_incident() {
        let directory = tempfile::tempdir().unwrap();
        let lease_file = directory.path().join("focus.json");
        let restore_file = directory.path().join("focus-restore.json");
        let active = exited_focus_child("session-crashed", "generation-a", false);
        write_lease_at(&lease_file, &active.lease).unwrap();
        let incidents = AtomicUsize::new(0);

        finalize_active_child_exit(&active, &lease_file, &restore_file, |session_id| {
            assert_eq!(session_id, "session-crashed");
            assert!(!lease_file.exists(), "lease must be removed before revoke");
            incidents.fetch_add(1, Ordering::SeqCst);
        });

        assert_eq!(incidents.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn expected_focus_hud_stop_cleans_without_reporting_incident() {
        let directory = tempfile::tempdir().unwrap();
        let lease_file = directory.path().join("focus.json");
        let restore_file = directory.path().join("focus-restore.json");
        let active = exited_focus_child("session-stopped", "generation-b", true);
        write_lease_at(&lease_file, &active.lease).unwrap();
        let incidents = AtomicUsize::new(0);

        finalize_active_child_exit(&active, &lease_file, &restore_file, |_| {
            incidents.fetch_add(1, Ordering::SeqCst);
        });

        assert!(!lease_file.exists());
        assert_eq!(incidents.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn focus_lease_is_bound_to_one_session() {
        let lease = lease("authorized", 42, "generation-a");
        assert_eq!(lease.session_id, "authorized");
        assert_ne!(lease.session_id, "another-session");
    }

    #[test]
    fn focus_lease_round_trips_without_extra_authority() {
        let lease = lease("session-1", 99, "generation-a");
        let value = serde_json::to_value(&lease).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "session_id":"session-1",
                "pid":99,
                "generation":"generation-a"
            })
        );
        assert!(value.get("app").is_none());
        assert!(value.get("token").is_none());
    }

    #[test]
    fn live_foreign_focus_owner_is_refused_without_stopping_it() {
        let lease = lease("foreign-session", 4242, "generation-a");

        assert_eq!(
            existing_lease_decision(Some(&lease), "new-session", true, false),
            ExistingLeaseDecision::RefuseLiveForeign {
                session_id: "foreign-session".into(),
                pid: 4242,
            },
        );
    }

    #[test]
    fn same_session_owner_is_replaced_only_after_graceful_stop() {
        let lease = lease("same-session", 4242, "generation-a");

        assert_eq!(
            existing_lease_decision(Some(&lease), "same-session", true, true),
            ExistingLeaseDecision::ReplaceSameSession(lease),
        );
    }

    #[test]
    fn live_same_session_without_local_generation_ownership_is_refused() {
        let lease = lease("same-session", 4242, "foreign-generation");

        assert_eq!(
            existing_lease_decision(Some(&lease), "same-session", true, false),
            ExistingLeaseDecision::RefuseLiveForeign {
                session_id: "same-session".into(),
                pid: 4242,
            },
        );
    }

    #[test]
    fn dead_owner_requires_stale_restore_before_starting() {
        let lease = lease("old-session", 4242, "generation-a");

        assert_eq!(
            existing_lease_decision(Some(&lease), "new-session", false, false),
            ExistingLeaseDecision::RecoverStale(lease),
        );
    }

    #[cfg(unix)]
    #[test]
    fn lease_is_atomically_persisted_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("focus.json");
        let first = lease("first", 10, "generation-a");
        let second = lease("second", 20, "generation-b");

        write_lease_at(&path, &first).unwrap();
        write_lease_at(&path, &second).unwrap();

        let persisted: FocusLease = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted, second);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
            0o700,
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn owned_helper_is_reaped_before_replacement_continues() {
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("trap 'exit 0' TERM; while :; do :; done")
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(25));

        terminate_child_and_wait(&mut child).unwrap();

        assert!(child.try_wait().unwrap().is_some());
        assert!(!process_is_alive(child.id()).unwrap());
    }

    #[test]
    fn exiting_old_helper_cannot_remove_a_replacement_lease() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("focus.json");
        let replacement = lease("same-session", 202, "new-generation");
        write_lease_at(&path, &replacement).unwrap();

        let old_helper = lease("same-session", 202, "old-generation");
        assert!(remove_lease_if_matches(&path, &old_helper).is_err());

        assert_eq!(read_lease_at(&path).unwrap(), Some(replacement));
    }

    #[test]
    fn persisted_pid_must_never_address_a_process_group() {
        assert!(lease("session", 0, "generation").validate().is_err());
        assert!(lease("session", 1, "generation").validate().is_err());
        assert!(lease("session", u32::MAX, "generation").validate().is_err());
    }

    #[test]
    fn unscoped_stop_refuses_a_live_unowned_generation() {
        let foreign = lease("foreign-session", std::process::id(), "foreign-generation");

        let error = refuse_unowned_live_lease(&foreign).unwrap_err();

        assert!(error.contains("live foreign focus owner"));
    }

    #[cfg(unix)]
    #[test]
    fn failed_termination_retains_active_identity_and_durable_lease() {
        let directory = tempfile::tempdir().unwrap();
        let lease_file = directory.path().join("focus.json");
        let restore_file = directory.path().join("focus-restore.json");
        let child = Arc::new(Mutex::new(
            std::process::Command::new("sh")
                .arg("-c")
                .arg("while :; do :; done")
                .spawn()
                .unwrap(),
        ));
        let child_pid = child.lock().unwrap().id();
        let mismatched_pid = child_pid.checked_add(1).unwrap();
        let owned_lease = lease("session", mismatched_pid, "retained-generation");
        let active = ActiveFocusChild {
            lease: owned_lease.clone(),
            child: Arc::clone(&child),
            expected_stop: Arc::new(AtomicBool::new(false)),
        };
        write_lease_at(&lease_file, &owned_lease).unwrap();
        register_active_child(active.clone()).unwrap();

        let error = cleanup_active_start_failure(
            "focus-ready mismatch".into(),
            &active,
            &lease_file,
            &restore_file,
        );

        assert!(error.contains("ownership and lease retained"));
        assert_eq!(
            read_lease_at(&lease_file).unwrap(),
            Some(owned_lease.clone())
        );
        assert!(active_child_for(&owned_lease).unwrap().is_some());

        clear_active_child_if_matches(&owned_lease).unwrap();
        let mut child = child.lock().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        remove_file_if_exists(&lease_file).unwrap();
    }

    #[test]
    fn invalid_persisted_pid_fails_before_liveness_checks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("focus.json");
        fs::write(
            &path,
            br#"{"session_id":"session","pid":0,"generation":"generation"}"#,
        )
        .unwrap();

        assert!(read_lease_at(&path).is_err());
    }

    #[test]
    fn protocol_generation_must_match_both_handshake_phases() {
        let mut valid = BufReader::new(
            b"{\"event\":\"focus-prepared\",\"generation\":\"generation-a\"}\n".as_slice(),
        );
        read_focus_protocol_event(&mut valid, "focus-prepared", "generation-a").unwrap();

        let mut ready = BufReader::new(
            b"{\"event\":\"focus-ready\",\"generation\":\"generation-a\",\"target_observed\":true,\"compact_layout_applied\":true,\"display_id\":7}\n".as_slice(),
        );
        let ready = read_focus_protocol_event(&mut ready, "focus-ready", "generation-a").unwrap();
        assert!(ready.target_observed);
        assert!(ready.compact_layout_applied);
        assert_eq!(ready.display_id, Some(7));

        let mut stale = BufReader::new(
            b"{\"event\":\"focus-ready\",\"generation\":\"old-generation\"}\n".as_slice(),
        );
        assert!(read_focus_protocol_event(&mut stale, "focus-ready", "new-generation").is_err());
    }

    #[test]
    fn delayed_layout_status_is_generation_bound_and_requires_a_real_target() {
        let event = |generation: &str, target_observed: bool| FocusProtocolEvent {
            event: "focus-layout".into(),
            generation: generation.into(),
            target_observed,
            compact_layout_applied: true,
            display_id: Some(7),
        };

        let receipt = focus_layout_receipt(event("current", true), "current").unwrap();
        assert!(receipt.target_observed);
        assert!(receipt.compact_layout_applied);
        assert_eq!(receipt.display_id, Some(7));
        assert!(focus_layout_receipt(event("stale", true), "current").is_none());
        assert!(focus_layout_receipt(event("current", false), "current").is_none());
    }
}
