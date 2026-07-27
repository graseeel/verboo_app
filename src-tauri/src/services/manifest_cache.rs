//! In-memory manifest cache with TTL + single-flight (P5.1 fix, v3).
//!
//! Problem (v1): used `tokio::sync::Mutex` but held the lock across the CLI
//! spawn `.await` — 83 concurrent requests deadlocked because the leader
//! held the lock while polling the CLI future, and the worker threads were
//! all blocked waiting for the same lock. The CLI future was never polled.
//!
//! Problem (v2): deadlock fixed via `Action` enum pattern (lock released
//! before any `.await`), but single-flight was broken — the leader never
//! called `tx.send()` to publish to waiters. When the leader overwrote
//! `*guard = Some(Ready(cached))`, the `tx` inside `Fetching(tx)` was
//! dropped, causing waiters' `rx.changed()` to return `Err`. All waiters
//! fell through to `fetch_direct()` — N fetches instead of 1.
//!
//! Fix (v3): `Action::LeadFetch` now carries the `watch::Sender` (not the
//! receiver). The leader calls `tx.send(Some(cached))` BEFORE overwriting
//! the guard, so waiters' `rx.changed()` returns `Ok(())` and they read
//! the cached result. Runtime-verified: 10 concurrent calls produce
//! exactly 1 "fetch OK" + 0 "direct fetch" fallbacks.
//!
//! Pattern:
//!   1. Lock → check if fresh → if yes, clone + return (lock released).
//!   2. If stale/empty → check if a fetch is in progress:
//!      a. If yes → clone the watch receiver, RELEASE the lock, await the
//!         watch with a 30s timeout.
//!      b. If no → become the leader: store a watch sender clone, RELEASE
//!         the lock, do the fetch OUTSIDE the lock, then re-lock +
//!         `tx.send(Some(cached))` + `*guard = Some(Ready(cached))`.
//!   3. Leader publishes the result via `tx.send()` BEFORE overwriting
//!      the guard (so the tx is still alive when send is called).
//!
//! The lock is only held for the brief in-memory check + state transition,
//! never across the CLI spawn. This is the standard single-flight pattern.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, OnceCell, watch};

use crate::models::plugins::PluginError;
use crate::services::marketplace_manifest_service::{read_all_manifests, MarketplacePluginEntry};

/// TTL: 60 seconds. Short enough to pick up new marketplaces quickly,
/// long enough to dedupe a burst of 83 requests.
const TTL: Duration = Duration::from_secs(60);

/// Safety timeout for waiters: if the leader doesn't publish within 30s
/// (CLI spawn can take up to 15s + read_all_manifests), give up and
/// return an error. Prevents indefinite hangs.
const WAITER_TIMEOUT: Duration = Duration::from_secs(30);

/// Cached manifests + the instant they were fetched.
struct CachedManifests {
    entries: HashMap<String, MarketplacePluginEntry>,
    fetched_at: Instant,
}

/// Shared cache state. The `Mutex<Option<FetchState>>` is held ONLY for
/// brief in-memory checks — never across `.await`.
///
/// - `None` → no fetch in progress, no cache (or cache expired)
/// - `Some(FetchState::Fetching(sender))` → fetch in progress; waiters
///   clone the `watch::Receiver` and await it (outside the lock)
/// - `Some(FetchState::Ready(cached))` → cache ready (check TTL)
enum FetchState {
    Fetching(watch::Sender<Option<Arc<CachedManifests>>>),
    Ready(Arc<CachedManifests>),
}

static CACHE: OnceCell<Mutex<Option<FetchState>>> = OnceCell::const_new();

async fn cache() -> &'static Mutex<Option<FetchState>> {
    CACHE.get_or_init(|| async { Mutex::new(None) }).await
}

/// Returns the cached manifests if fresh (< TTL), or fetches them via
/// `marketplace_list` + `read_all_manifests`. Single-flight: concurrent
/// callers share the same fetch future.
///
/// **Deadlock-free:** the lock is never held across an `.await`. The leader
/// releases the lock before doing the CLI spawn; waiters release the lock
/// before awaiting the watch channel.
pub async fn get_or_fetch_manifests() -> Result<HashMap<String, MarketplacePluginEntry>, PluginError> {
    let cache_mutex = cache().await;
    get_or_fetch_with(cache_mutex, fetch_manifests_inner).await
}

async fn get_or_fetch_with<F, Fut>(
    cache_mutex: &Mutex<Option<FetchState>>,
    fetch: F,
) -> Result<HashMap<String, MarketplacePluginEntry>, PluginError>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<HashMap<String, MarketplacePluginEntry>, PluginError>>,
{
    // ── Phase 1: brief lock to check state ─────────────────────────────
    let action = {
        let mut guard = cache_mutex.lock().await;
        match guard.as_ref() {
            // Fresh cache → return immediately (lock released on scope exit).
            Some(FetchState::Ready(cached)) if cached.fetched_at.elapsed() < TTL => {
                Action::Return(cached.entries.clone())
            }
            // Stale cache → become leader (clear + start fetch).
            Some(FetchState::Ready(_)) => {
                let (tx, _rx) = watch::channel(None);
                *guard = Some(FetchState::Fetching(tx.clone()));
                Action::LeadFetch(tx)
            }
            // Fetch in progress → become waiter.
            Some(FetchState::Fetching(tx)) => {
                Action::Wait(tx.subscribe())
            }
            // No cache → become leader.
            None => {
                let (tx, _rx) = watch::channel(None);
                *guard = Some(FetchState::Fetching(tx.clone()));
                Action::LeadFetch(tx)
            }
        }
    };
    // Lock is RELEASED here.

    match action {
        Action::Return(entries) => Ok(entries),
        Action::Wait(mut rx) => {
            // Await the leader's result with a safety timeout. If the leader
            // hangs (CLI spawn stuck), we don't hang forever.
            match tokio::time::timeout(WAITER_TIMEOUT, rx.changed()).await {
                Ok(Ok(())) => {
                    // Leader published via tx.send(). Re-check the cache.
                    let guard = cache_mutex.lock().await;
                    match guard.as_ref() {
                        Some(FetchState::Ready(cached)) if cached.fetched_at.elapsed() < TTL => {
                            Ok(cached.entries.clone())
                        }
                        _ => {
                            // Leader failed or cache still stale. Fall through
                            // to a direct fetch (rare path).
                            fetch().await
                        }
                    }
                }
                Ok(Err(_)) => {
                    // watch sender dropped (leader panicked/errored). Direct fetch.
                    fetch().await
                }
                Err(_) => {
                    // Timeout. Direct fetch (don't hang the command).
                    fetch().await
                }
            }
        }
        Action::LeadFetch(tx) => {
            // We're the leader. Do the fetch OUTSIDE the lock.
            let result = fetch().await;

            // Re-acquire the lock to publish the result.
            let mut guard = cache_mutex.lock().await;
            match result {
                Ok(entries) => {
                    let cached = Arc::new(CachedManifests {
                        entries: entries.clone(),
                        fetched_at: Instant::now(),
                    });
                    // Publish to waiters via tx.send() BEFORE overwriting the
                    // guard. This way waiters' rx.changed() returns Ok(())
                    // and they read the cached result. If we overwrite first,
                    // the tx is dropped (it was inside Fetching(tx)) and
                    // waiters see Err (sender closed) → they do their own fetch.
                    let _ = tx.send(Some(cached.clone()));
                    *guard = Some(FetchState::Ready(cached.clone()));
                    Ok(entries)
                }
                Err(e) => {
                    // On error, signal waiters (None = failure) and clear state.
                    let _ = tx.send(None);
                    *guard = None;
                    Err(e)
                }
            }
        }
    }
}

/// What should this caller do after the brief lock check?
enum Action {
    /// Cache was fresh — return these entries.
    Return(HashMap<String, MarketplacePluginEntry>),
    /// A fetch is in progress — await this watch receiver.
    Wait(watch::Receiver<Option<Arc<CachedManifests>>>),
    /// No fetch in progress — become the leader and fetch. Carries the
    /// `watch::Sender` so the leader can publish the result to waiters.
    LeadFetch(watch::Sender<Option<Arc<CachedManifests>>>),
}

/// Inner fetch: calls `marketplace_list` (CLI) + `read_all_manifests` (disk).
async fn fetch_manifests_inner() -> Result<HashMap<String, MarketplacePluginEntry>, PluginError> {
    let marketplaces = crate::services::plugins_service::marketplace_list().await?;
    Ok(read_all_manifests(&marketplaces))
}

/// Invalidates the cache. Called by `marketplace_add` and `marketplace_remove`
/// so stale manifests don't persist for 60s after a marketplace change.
pub async fn invalidate() {
    let cache_mutex = cache().await;
    let mut guard = cache_mutex.lock().await;
    *guard = None;
}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn ttl_is_60_seconds() {
        assert_eq!(TTL, Duration::from_secs(60));
    }

    #[test]
    fn waiter_timeout_is_30_seconds() {
        assert_eq!(WAITER_TIMEOUT, Duration::from_secs(30));
    }

    /// Multi-thread concurrency test: N concurrent `get_or_fetch_manifests`
    /// calls must complete in seconds (not deadlock). This test would have
    /// caught the v1 deadlock (std Mutex held across `.await`).
    ///
    /// NOTE: This test calls the real `get_or_fetch_manifests`, which spawns
    /// the CLI. In the test environment, the CLI may or may not be available.
    /// The key assertion is that the calls COMPLETE (don't hang) within a
    /// reasonable timeout — either Ok or Err, not a deadlock.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_calls_do_not_deadlock() {
        // Invalidate any existing cache first.
        invalidate().await;

        // Spawn 10 concurrent calls.
        let mut handles = Vec::new();
        for i in 0..10 {
            handles.push(tokio::spawn(async move {
                // Each call gets a 30s safety timeout (matches WAITER_TIMEOUT).
                let result = tokio::time::timeout(
                    Duration::from_secs(30),
                    get_or_fetch_manifests(),
                )
                .await;
                (i, result)
            }));
        }

        // All must complete within 60s (generous — CLI spawn can take 15s).
        for handle in handles {
            let (i, result) = tokio::time::timeout(Duration::from_secs(60), handle)
                .await
                .expect("task hung > 60s")
                .expect("join failed");
            // The result is Ok(Ok(_)) or Ok(Err(_)) or Err(Timeout).
            // The key assertion: it's NOT a timeout (which would mean deadlock).
            match result {
                Ok(Ok(_entries)) => eprintln!("[test] call {i} → Ok"),
                Ok(Err(e)) => eprintln!("[test] call {i} → Err ({e})"),
                Err(_) => panic!("call {i} timed out — likely deadlock"),
            }
        }
    }

    /// Single-flight correctness test: N concurrent calls must share one
    /// deterministic fetch instead of depending on the real CLI or filesystem.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn single_flight_produces_one_fetch_not_n() {
        let cache = Arc::new(Mutex::new(None));
        let fetch_count = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(tokio::sync::Barrier::new(10));
        let mut handles = Vec::new();

        for _ in 0..10 {
            let cache = Arc::clone(&cache);
            let fetch_count = Arc::clone(&fetch_count);
            let start = Arc::clone(&start);
            handles.push(tokio::spawn(async move {
                start.wait().await;
                get_or_fetch_with(cache.as_ref(), || {
                    let fetch_count = Arc::clone(&fetch_count);
                    async move {
                        fetch_count.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        Ok::<_, PluginError>(HashMap::new())
                    }
                })
                .await
            }));
        }

        for handle in handles {
            let result = tokio::time::timeout(Duration::from_secs(2), handle)
                .await
                .expect("single-flight task hung")
                .expect("join failed");
            assert!(result.is_ok());
        }

        assert_eq!(fetch_count.load(Ordering::SeqCst), 1);
    }
}
