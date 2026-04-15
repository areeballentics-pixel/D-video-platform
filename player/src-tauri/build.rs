fn main() {
    // Rebuild when the production server URL changes so `option_env!` picks it up.
    println!("cargo:rerun-if-env-changed=SVP_SERVER_URL");
    tauri_build::build()
}
