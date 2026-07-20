use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime};

use uuid::Uuid;

const STALE_JOB_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// A child process owned by a video preparation job. The registry only needs
/// interruption; callers retain the concrete handle needed to await it.
pub trait VideoProcess: Send + Sync {
    fn interrupt(&self);
}

/// Thread-safe wrapper around a spawned media child.
pub struct ManagedVideoChild {
    child: Mutex<Child>,
}

impl ManagedVideoChild {
    pub fn new(child: Child) -> Self {
        Self {
            child: Mutex::new(child),
        }
    }

    pub(crate) fn with_child<T>(&self, operation: impl FnOnce(&mut Child) -> T) -> Option<T> {
        self.child.lock().ok().map(|mut child| operation(&mut child))
    }
}

impl VideoProcess for ManagedVideoChild {
    fn interrupt(&self) {
        let _ = self
            .child
            .lock()
            .ok()
            .and_then(|mut child| crate::services::child_signal::interrupt_child(&mut child).ok());
    }
}

struct ActiveJob {
    conversation_id: String,
    directory: PathBuf,
    cancelled: Arc<AtomicBool>,
    processes: HashMap<u64, Arc<dyn VideoProcess>>,
}

#[derive(Default)]
struct RegistryState {
    jobs: HashMap<String, ActiveJob>,
    jobs_by_conversation: HashMap<String, String>,
    next_process_id: u64,
}

#[derive(Clone)]
pub struct VideoJobRegistry {
    root: PathBuf,
    state: Arc<Mutex<RegistryState>>,
}

impl VideoJobRegistry {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let root = app_data_dir.as_ref().join("video_jobs");
        fs::create_dir_all(&root).map_err(|error| format!("create video job root: {error}"))?;
        prune_stale_job_directories(&root)?;
        Ok(Self {
            root,
            state: Arc::new(Mutex::new(RegistryState::default())),
        })
    }

    pub fn start(&self, conversation_id: impl Into<String>) -> Result<VideoJob, String> {
        let conversation_id = conversation_id.into();
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.jobs_by_conversation.contains_key(&conversation_id) {
            return Err("a video job is already active for this conversation".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let directory = self.root.join(&id);
        fs::create_dir(&directory).map_err(|error| format!("create video job directory: {error}"))?;
        let cancelled = Arc::new(AtomicBool::new(false));
        state.jobs_by_conversation.insert(conversation_id.clone(), id.clone());
        state.jobs.insert(
            id.clone(),
            ActiveJob {
                conversation_id,
                directory: directory.clone(),
                cancelled: cancelled.clone(),
                processes: HashMap::new(),
            },
        );
        Ok(VideoJob {
            id,
            directory,
            cancelled,
            registry: self.clone(),
        })
    }

    /// Cancels only the job owned by `conversation_id`. A cancelled job is
    /// removed from the active map before children are signalled so repeated
    /// interrupts are harmless and cannot target a future job.
    pub fn interrupt(&self, conversation_id: &str) -> Result<bool, String> {
        let job_id = self
            .state
            .lock()
            .map_err(|error| error.to_string())?
            .jobs_by_conversation
            .get(conversation_id)
            .cloned();
        let Some(job_id) = job_id else {
            return Ok(false);
        };
        self.cancel_job(&job_id)
    }

    pub fn prune_stale(&self) -> Result<(), String> {
        prune_stale_job_directories(&self.root)
    }

    fn register_process(
        &self,
        job_id: &str,
        process: Arc<dyn VideoProcess>,
    ) -> Result<VideoProcessRegistration, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let process_id = state.next_process_id;
        state.next_process_id = state.next_process_id.wrapping_add(1);
        let Some(job) = state.jobs.get_mut(job_id) else {
            drop(state);
            process.interrupt();
            return Err("video job is no longer active".to_string());
        };
        if job.cancelled.load(Ordering::Acquire) {
            drop(state);
            process.interrupt();
            return Err("video job was cancelled".to_string());
        }
        job.processes.insert(process_id, process);
        Ok(VideoProcessRegistration {
            registry: self.clone(),
            job_id: job_id.to_string(),
            process_id,
        })
    }

    fn deregister_process(&self, job_id: &str, process_id: u64) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(job) = state.jobs.get_mut(job_id) {
                job.processes.remove(&process_id);
            }
        }
    }

    fn cancel_job(&self, job_id: &str) -> Result<bool, String> {
        let active = {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            let Some(active) = state.jobs.remove(job_id) else {
                return Ok(false);
            };
            state.jobs_by_conversation.remove(&active.conversation_id);
            active
        };
        active.cancelled.store(true, Ordering::Release);
        for process in active.processes.values() {
            process.interrupt();
        }
        remove_job_directory(&active.directory)?;
        Ok(true)
    }

    fn finish_job(&self, job_id: &str) -> Result<(), String> {
        let active = {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            let Some(active) = state.jobs.remove(job_id) else {
                return Ok(());
            };
            state.jobs_by_conversation.remove(&active.conversation_id);
            active
        };
        remove_job_directory(&active.directory)
    }
}

pub struct VideoJob {
    id: String,
    directory: PathBuf,
    cancelled: Arc<AtomicBool>,
    registry: VideoJobRegistry,
}

impl VideoJob {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn register_process(
        &self,
        process: Arc<dyn VideoProcess>,
    ) -> Result<VideoProcessRegistration, String> {
        self.registry.register_process(&self.id, process)
    }

    pub fn cancel(&self) -> Result<bool, String> {
        self.registry.cancel_job(&self.id)
    }

    /// Removes this job directory after a successful or failed preparation.
    /// Registered processes must already have exited before callers finish.
    pub fn finish(&self) -> Result<(), String> {
        self.registry.finish_job(&self.id)
    }
}

impl Drop for VideoJob {
    fn drop(&mut self) {
        // A preparation failure can return before its normal `finish` path.
        // The guard keeps the app-private directory from surviving that path.
        let _ = self.registry.finish_job(&self.id);
    }
}

pub struct VideoProcessRegistration {
    registry: VideoJobRegistry,
    job_id: String,
    process_id: u64,
}

impl Drop for VideoProcessRegistration {
    fn drop(&mut self) {
        self.registry
            .deregister_process(&self.job_id, self.process_id);
    }
}

fn remove_job_directory(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove video job directory: {error}")),
    }
}

fn prune_stale_job_directories(root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| format!("read video job root: {error}"))? {
        let entry = entry.map_err(|error| format!("read video job entry: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("inspect video job entry: {error}"))?
            .is_dir()
        {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if Uuid::parse_str(&name).is_err() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::now());
        if SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default()
            >= STALE_JOB_AGE
        {
            remove_job_directory(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use tempfile::TempDir;

    use super::{VideoJobRegistry, VideoProcess};

    struct FakeProcess(AtomicUsize);

    impl VideoProcess for FakeProcess {
        fn interrupt(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn cancelling_a_job_interrupts_all_children_and_cleans_only_its_directory() {
        let temp = TempDir::new().unwrap();
        let registry = VideoJobRegistry::new(temp.path()).unwrap();
        let first = registry.start("conversation-a").unwrap();
        let second = registry.start("conversation-b").unwrap();
        let first_child = Arc::new(FakeProcess(AtomicUsize::new(0)));
        let second_child = Arc::new(FakeProcess(AtomicUsize::new(0)));
        let _first_registration = first.register_process(first_child.clone()).unwrap();
        let _second_registration = second.register_process(second_child.clone()).unwrap();

        assert!(first.directory().is_dir());
        assert!(second.directory().is_dir());
        assert!(registry.interrupt("conversation-a").unwrap());

        assert!(first.is_cancelled());
        assert_eq!(first_child.0.load(Ordering::SeqCst), 1);
        assert_eq!(second_child.0.load(Ordering::SeqCst), 0);
        assert!(!first.directory().exists());
        assert!(second.directory().is_dir());

        assert!(!registry.interrupt("conversation-a").unwrap());
        assert_eq!(first_child.0.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_an_unfinished_job_cleans_its_directory_and_releases_conversation() {
        let temp = TempDir::new().unwrap();
        let registry = VideoJobRegistry::new(temp.path()).unwrap();
        let directory = {
            let job = registry.start("conversation-a").unwrap();
            job.directory().to_path_buf()
        };

        assert!(!directory.exists());
        assert!(registry.start("conversation-a").is_ok());
    }
}
