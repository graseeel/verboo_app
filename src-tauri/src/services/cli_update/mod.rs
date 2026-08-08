pub mod archive;
pub mod contract;
pub mod download;
pub mod service;
pub mod store;

pub use service::CliUpdateService;
pub use store::{CliRuntimeLease, CliStore};

pub const DESKTOP_PROTOCOL: u32 = 1;
pub const EMBEDDED_NODE_VERSION: &str = "24.19.0";
pub const EMBEDDED_NODE_MODULES: &str = "137";
pub const EMBEDDED_NODE_NAPI: &str = "10";
pub const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
