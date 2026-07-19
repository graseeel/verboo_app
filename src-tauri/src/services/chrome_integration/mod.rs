mod cli_mcp;
mod diagnostics;
mod installer;
mod manifest;
mod models;
mod paths;

pub use installer::ChromeIntegrationService;
pub use models::*;

#[cfg(test)]
mod tests;
