// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--computer-use-mcp") {
        if let Err(error) = verboo_desktop_lib::run_computer_use_mcp() {
            eprintln!("computer-use MCP failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    verboo_desktop_lib::run()
}
