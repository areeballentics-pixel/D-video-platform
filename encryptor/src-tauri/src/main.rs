// main.rs — Entry point for the SVP Encryptor executable.
//
// Hides the console window in release builds (Windows) so when an institute
// admin double-clicks the .exe, they see the app window only — not a
// blank terminal behind it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    svp_encryptor_lib::run()
}
