use std::path::{Path, PathBuf};

use dirs::home_dir;

const HOST_FILE: &str = "com.verboo.code.browser_extension.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntegrationPlatform {
    Macos,
    Windows,
    Linux,
}

impl IntegrationPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChromeIntegrationPaths {
    platform: IntegrationPlatform,
    data_root: PathBuf,
    config_root: PathBuf,
    home_root: PathBuf,
    app_version: String,
}

impl ChromeIntegrationPaths {
    pub fn for_current_user(app_version: impl Into<String>) -> Result<Self, String> {
        let base = dirs::data_local_dir().ok_or("chrome_paths_data_unavailable")?;
        let config = if cfg!(target_os = "macos") {
            dirs::data_dir().ok_or("chrome_paths_config_unavailable")?
        } else {
            dirs::config_dir().ok_or("chrome_paths_config_unavailable")?
        };
        let home = home_dir().ok_or("chrome_paths_home_unavailable")?;
        Ok(Self::for_roots(
            IntegrationPlatform::current(),
            base.join("Verboo Code"),
            config,
            home,
            app_version,
        ))
    }

    pub fn for_roots(
        platform: IntegrationPlatform,
        data_root: PathBuf,
        config_root: PathBuf,
        home_root: PathBuf,
        app_version: impl Into<String>,
    ) -> Self {
        Self {
            platform,
            data_root,
            config_root,
            home_root,
            app_version: app_version.into(),
        }
    }

    pub fn platform(&self) -> IntegrationPlatform {
        self.platform
    }

    pub fn integration_root(&self) -> PathBuf {
        self.data_root.join("chrome-integration")
    }

    pub fn helper_path(&self) -> PathBuf {
        let executable = if self.platform == IntegrationPlatform::Windows {
            "verboo-in-chrome.exe"
        } else {
            "verboo-in-chrome"
        };
        self.integration_root()
            .join(&self.app_version)
            .join(executable)
    }

    pub fn installation_record_path(&self) -> PathBuf {
        self.integration_root().join("installation.json")
    }

    pub fn manifest_path(&self) -> PathBuf {
        match self.platform {
            IntegrationPlatform::Macos => self.config_root.join(mac_manifest_suffix()),
            IntegrationPlatform::Linux => self.config_root.join(linux_manifest_suffix()),
            IntegrationPlatform::Windows => self.integration_root().join(HOST_FILE),
        }
    }

    pub fn cli_user_config_path(&self) -> PathBuf {
        std::env::var_os("VERBOO_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home_root.join(".verboo"))
            .join(".config.json")
    }

    pub fn app_version(&self) -> &str {
        &self.app_version
    }

    pub fn is_managed_helper_path(&self, path: &Path) -> bool {
        path.starts_with(self.integration_root())
            && path.file_name() == self.helper_path().file_name()
    }
}

pub const fn mac_manifest_suffix() -> &'static str {
    "Google/Chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json"
}

pub const fn linux_manifest_suffix() -> &'static str {
    "google-chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json"
}

pub const fn windows_registry_key() -> &'static str {
    r"Software\Google\Chrome\NativeMessagingHosts\com.verboo.code.browser_extension"
}

pub const fn edge_registry_key() -> &'static str {
    r"Software\Microsoft\Edge\NativeMessagingHosts\com.verboo.code.browser_extension"
}
