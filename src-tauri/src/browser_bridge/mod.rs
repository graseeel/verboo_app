//! Browser Bridge — Desktop ↔ Chrome Extension via Native Messaging.
//!
//! Architecture (P4): the Chrome extension is the **sole Browser Controller**.
//! Desktop/CLI are clients: they send tool calls over Native Messaging; the
//! extension's `controller.execute()` runs the policy gate and dispatches.
//! Desktop never calls `chrome.*` directly.
//!
//! Host name: `com.verboo.code.browser_extension` (non-personal product identifier).
//!
//! Multi-user: zero hardcoded paths. Per-OS install paths resolve via
//! `dirs::config_dir()` at runtime. The host binary is bundled with the
//! Desktop app; the installer writes the manifest.
//!
//! See:
//!   - `extensions/verboo-chrome/native-messaging/PROTOCOL.md` (wire reference)
//!   - `docs/control-chrome/native-messaging-design.md` (design rationale, gitignored)
//!
//! P4 scope: contracts + host registration + client stub. Full turn loop
//! and streaming thoughts land later in P4 follow-up or P5.

pub mod client;
pub mod host;
pub mod native_messaging;

pub use client::{send_tool_call, ClientError};
pub use host::{register_host, HostError, HostManifest};
pub use native_messaging::{decode_message, encode_message, FrameError};

/// The Native Messaging host name. Stable, non-personal.
pub const HOST_NAME: &str = "com.verboo.code.browser_extension";
