// lib.rs — Tauri builder + IPC handler registration.

pub mod api_client;
pub mod commands;
pub mod errors;
pub mod jobs;
pub mod keystore;
pub mod mp4_probe;
pub mod pipeline;
pub mod state;

use crate::state::AppState;


/// Build and run the SVP Encryptor Tauri app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new().expect("failed to initialize AppState");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::login,
            commands::register_encryptor,
            commands::refresh_master_key,
            commands::logout,
            commands::forget_master_key,
            commands::start_encryption_job,
            commands::list_jobs,
            commands::cancel_job,
            commands::submit_download_urls,
            commands::set_settings,
            commands::get_app_version,
            commands::get_device_info,
            commands::get_api_auth,
        ])
        .setup(|_app| {
            env_logger::init();
            log::info!("SVP Encryptor v{} started", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
