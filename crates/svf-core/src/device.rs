// device.rs — Hardware fingerprinting for device binding.
//
// Collects hardware identifiers per platform and combines them into a single
// SHA-256 fingerprint. Result is cached to disk so subsequent launches return
// the same fingerprint without re-querying the OS.

use crate::errors::SvfCoreError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

/// Information about the current device, sent to the license server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub fingerprint: String,
    pub hostname: String,
    pub os_version: String,
    pub device_id: Option<String>,
}

fn cache_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "secure-video-player", "secure-video-player")
        .map(|dirs| dirs.data_dir().join("device.json"))
}

fn load_cached() -> Option<DeviceInfo> {
    let path = cache_path()?;
    let data = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_cache(info: &DeviceInfo) -> Result<(), SvfCoreError> {
    if let Some(path) = cache_path() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(info)?;
        fs::write(&path, json)?;
    }
    Ok(())
}

/// Collect a device fingerprint, using a cached value if available.
pub fn collect_fingerprint() -> Result<DeviceInfo, SvfCoreError> {
    if let Some(cached) = load_cached() {
        return Ok(cached);
    }

    let fingerprint = collect_hardware_fingerprint()?;

    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let os_version = std::env::consts::OS.to_string();

    let info = DeviceInfo {
        fingerprint,
        hostname,
        os_version,
        device_id: None,
    };

    if let Err(e) = save_cache(&info) {
        log::warn!("Failed to cache device fingerprint: {}", e);
    }

    Ok(info)
}

#[cfg(target_os = "windows")]
fn collect_hardware_fingerprint() -> Result<String, SvfCoreError> {
    use wmi::WMIConnection;

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Win32Processor {
        processor_id: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Win32BaseBoard {
        serial_number: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Win32Bios {
        serial_number: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Win32DiskDrive {
        serial_number: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Win32NetworkAdapter {
        #[serde(rename = "MACAddress")]
        mac_address: Option<String>,
    }

    let wmi_con = WMIConnection::new()
        .map_err(|e| SvfCoreError::Device(format!("Failed to connect to WMI: {}", e)))?;

    let cpu_id: String = wmi_con
        .raw_query::<Win32Processor>("SELECT ProcessorId FROM Win32_Processor")
        .ok()
        .and_then(|results: Vec<Win32Processor>| results.into_iter().next())
        .and_then(|p| p.processor_id)
        .unwrap_or_else(|| "unknown".to_string());

    let mb_serial: String = wmi_con
        .raw_query::<Win32BaseBoard>("SELECT SerialNumber FROM Win32_BaseBoard")
        .ok()
        .and_then(|results: Vec<Win32BaseBoard>| results.into_iter().next())
        .and_then(|b| b.serial_number)
        .unwrap_or_else(|| "unknown".to_string());

    let bios_serial: String = wmi_con
        .raw_query::<Win32Bios>("SELECT SerialNumber FROM Win32_BIOS")
        .ok()
        .and_then(|results: Vec<Win32Bios>| results.into_iter().next())
        .and_then(|b| b.serial_number)
        .unwrap_or_else(|| "unknown".to_string());

    let disk_serial: String = wmi_con
        .raw_query::<Win32DiskDrive>("SELECT SerialNumber FROM Win32_DiskDrive")
        .ok()
        .and_then(|results: Vec<Win32DiskDrive>| results.into_iter().next())
        .and_then(|d| d.serial_number)
        .unwrap_or_else(|| "unknown".to_string());

    let mac_address: String = wmi_con
        .raw_query::<Win32NetworkAdapter>(
            "SELECT MACAddress FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=TRUE",
        )
        .ok()
        .and_then(|results: Vec<Win32NetworkAdapter>| results.into_iter().next())
        .and_then(|n| n.mac_address)
        .unwrap_or_else(|| "unknown".to_string());

    log::info!(
        "Hardware IDs collected: CPU={}, MB={}, BIOS={}, Disk={}, MAC={}",
        cpu_id, mb_serial, bios_serial, disk_serial, mac_address
    );

    let combined = format!(
        "{}|{}|{}|{}|{}",
        cpu_id, mb_serial, bios_serial, disk_serial, mac_address
    );

    let hash = Sha256::digest(combined.as_bytes());
    Ok(hex::encode(hash))
}

#[cfg(not(target_os = "windows"))]
fn collect_hardware_fingerprint() -> Result<String, SvfCoreError> {
    // Non-Windows fallback: hash the hostname + OS as a basic identifier.
    // Mobile platforms (Android/iOS) will replace this with platform-specific
    // fingerprints when their JNI/FFI integrations land.
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let combined = format!("{}|{}", hostname, std::env::consts::OS);
    let hash = Sha256::digest(combined.as_bytes());
    Ok(hex::encode(hash))
}
