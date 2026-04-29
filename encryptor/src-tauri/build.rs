fn main() {
    // Rebuild when the production server URL env var changes so `option_env!`
    // bakes the right default into release builds.
    println!("cargo:rerun-if-env-changed=SVP_SERVER_URL");
    tauri_build::build()
}
