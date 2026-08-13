#[tokio::main]
async fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("mcp") => verboo_in_chrome::simulator_mcp::run_mcp().await,
        Some("ping") => verboo_in_chrome::simulator_mcp::run_ping(),
        _ => Err("usage: verboo-ios-simulator <mcp|ping>".into()),
    };
    if let Err(error) = result {
        eprintln!("verboo-ios-simulator: {error}");
        std::process::exit(1);
    }
}
