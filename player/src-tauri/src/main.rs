// main.rs — Entry point for the SecurePlayer executable
//
// This file is intentionally minimal. All the real setup happens in lib.rs.
// The #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// attribute hides the console window in release builds — so when a student
// double-clicks the .exe, they see only the player window, not a black
// terminal window behind it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    secure_video_player_lib::run()
}
