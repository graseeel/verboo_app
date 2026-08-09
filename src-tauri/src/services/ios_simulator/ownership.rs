use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::{detect_requirements, run_simctl, CommandRunner, IosSimulatorDevice};

const LEDGER_VERSION: u32 = 1;
const LEDGER_FILE: &str = "ownership.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorOwnership {
    External,
    Verboo,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OwnershipPhase {
    BootRequested,
    BootedByVerboo,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LedgerFile {
    version: u32,
    devices: BTreeMap<String, OwnershipPhase>,
}

pub(crate) struct OwnershipLedger {
    path: Option<PathBuf>,
    devices: Mutex<BTreeMap<String, OwnershipPhase>>,
}

impl OwnershipLedger {
    pub(crate) fn open(app_data_dir: PathBuf) -> Result<Self, String> {
        let root = app_data_dir.join("ios-simulator");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let path = root.join(LEDGER_FILE);
        let devices = if path.exists() {
            let file: LedgerFile =
                serde_json::from_slice(&std::fs::read(&path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            if file.version != LEDGER_VERSION {
                return Err(format!(
                    "versão desconhecida do ledger do simulador: {}",
                    file.version
                ));
            }
            file.devices
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            path: Some(path),
            devices: Mutex::new(devices),
        })
    }

    pub(crate) fn in_memory() -> Self {
        Self {
            path: None,
            devices: Mutex::new(BTreeMap::new()),
        }
    }

    pub(crate) fn mark_boot_requested(&self, udid: &str) -> Result<(), String> {
        self.update(udid, Some(OwnershipPhase::BootRequested))
    }

    pub(crate) fn mark_booted(&self, udid: &str) -> Result<(), String> {
        self.update(udid, Some(OwnershipPhase::BootedByVerboo))
    }

    pub(crate) fn remove(&self, udid: &str) -> Result<(), String> {
        self.update(udid, None)
    }

    pub(crate) fn phase(&self, udid: &str) -> Option<OwnershipPhase> {
        self.devices
            .lock()
            .expect("simulator ownership ledger poisoned")
            .get(udid)
            .copied()
    }

    pub(crate) fn owned_udids(&self) -> Vec<String> {
        self.devices
            .lock()
            .expect("simulator ownership ledger poisoned")
            .keys()
            .cloned()
            .collect()
    }

    fn update(&self, udid: &str, phase: Option<OwnershipPhase>) -> Result<(), String> {
        let mut devices = self
            .devices
            .lock()
            .expect("simulator ownership ledger poisoned");
        let previous = devices.clone();
        match phase {
            Some(phase) => {
                devices.insert(udid.to_string(), phase);
            }
            None => {
                devices.remove(udid);
            }
        }
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        if let Err(error) = persist_ledger(path, &devices) {
            *devices = previous;
            return Err(error);
        }
        Ok(())
    }
}

fn persist_ledger(path: &Path, devices: &BTreeMap<String, OwnershipPhase>) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&LedgerFile {
        version: LEDGER_VERSION,
        devices: devices.clone(),
    })
    .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[derive(Debug, Clone)]
pub(crate) struct AttachPreparation {
    pub(crate) device: IosSimulatorDevice,
    pub(crate) ownership: IosSimulatorOwnership,
    pub(crate) boot_required: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedDevice {
    pub(crate) device: IosSimulatorDevice,
    pub(crate) ownership: IosSimulatorOwnership,
}

pub(crate) fn prepare_device_for_attach(
    runner: &dyn CommandRunner,
    ledger: &OwnershipLedger,
    udid: &str,
) -> Result<AttachPreparation, String> {
    let requirements = detect_requirements(runner);
    if let Some(issue) = requirements.issue {
        return Err(super::issue_message(
            &issue,
            requirements.xcode_version.as_deref(),
        ));
    }
    let device = requirements
        .devices
        .into_iter()
        .find(|device| device.udid == udid)
        .ok_or_else(|| {
            "O simulador selecionado não está disponível. Atualize a lista e tente novamente."
                .to_string()
        })?;
    match device.state.as_str() {
        "Booted" => Ok(AttachPreparation {
            ownership: if ledger.phase(udid).is_some() {
                IosSimulatorOwnership::Verboo
            } else {
                IosSimulatorOwnership::External
            },
            device,
            boot_required: false,
        }),
        "Shutdown" => {
            ledger.mark_boot_requested(udid)?;
            Ok(AttachPreparation {
                device,
                ownership: IosSimulatorOwnership::Verboo,
                boot_required: true,
            })
        }
        state => Err(format!(
            "O simulador está em um estado transitório ({state}). Tente novamente."
        )),
    }
}

pub(crate) fn complete_device_boot(
    runner: &dyn CommandRunner,
    ledger: &OwnershipLedger,
    preparation: AttachPreparation,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<PreparedDevice, String> {
    if !preparation.boot_required {
        if preparation.ownership == IosSimulatorOwnership::Verboo {
            ledger.mark_booted(&preparation.device.udid)?;
        }
        return Ok(PreparedDevice {
            device: preparation.device,
            ownership: preparation.ownership,
        });
    }

    if cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline {
        return Err("inicialização do simulador cancelada".to_string());
    }
    if let Err(error) = run_simctl(runner, &["boot".into(), preparation.device.udid.clone()]) {
        reconcile_failed_boot(runner, ledger, &preparation.device.udid);
        return Err(error);
    }
    let bootstatus = run_bootstatus(runner, &preparation.device.udid, cancel, deadline);
    if let Err(error) = bootstatus {
        reconcile_failed_boot(runner, ledger, &preparation.device.udid);
        return Err(error);
    }
    ledger.mark_booted(&preparation.device.udid)?;
    let mut device = preparation.device;
    device.state = "Booted".to_string();
    Ok(PreparedDevice {
        device,
        ownership: IosSimulatorOwnership::Verboo,
    })
}

fn run_bootstatus(
    runner: &dyn CommandRunner,
    udid: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let output = runner.run_interruptible(
        "xcrun",
        &[
            "simctl".into(),
            "bootstatus".into(),
            udid.into(),
            "-b".into(),
        ],
        cancel,
        deadline,
    )?;
    if output.success {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            "O simctl não conseguiu aguardar a inicialização.".to_string()
        } else {
            message
        })
    }
}

fn reconcile_failed_boot(runner: &dyn CommandRunner, ledger: &OwnershipLedger, udid: &str) {
    let requirements = detect_requirements(runner);
    if requirements
        .devices
        .into_iter()
        .find(|device| device.udid == udid)
        .is_some_and(|device| device.state == "Shutdown")
    {
        let _ = ledger.remove(udid);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ledger_round_trips_boot_intent_atomically() {
        let root = tempfile::tempdir().unwrap();
        let ledger = super::OwnershipLedger::open(root.path().to_path_buf()).unwrap();
        ledger.mark_boot_requested("owned-phone").unwrap();
        let reopened = super::OwnershipLedger::open(root.path().to_path_buf()).unwrap();
        assert_eq!(
            reopened.phase("owned-phone"),
            Some(super::OwnershipPhase::BootRequested)
        );
        reopened.mark_booted("owned-phone").unwrap();
        assert_eq!(
            super::OwnershipLedger::open(root.path().to_path_buf())
                .unwrap()
                .phase("owned-phone"),
            Some(super::OwnershipPhase::BootedByVerboo),
        );
    }
}
