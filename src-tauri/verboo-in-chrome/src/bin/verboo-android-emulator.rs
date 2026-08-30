#[tokio::main]
async fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("mcp") => verboo_in_chrome::android_emulator_mcp::run_mcp().await,
        Some("ping") => verboo_in_chrome::android_emulator_mcp::run_ping(),
        _ => Err("usage: verboo-android-emulator <mcp|ping>".into()),
    };
    if let Err(error) = result {
        eprintln!("verboo-android-emulator: {error}");
        std::process::exit(1);
    }
}
