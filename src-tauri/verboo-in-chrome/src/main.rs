use verboo_in_chrome::{run_mcp, run_native_host, run_ping};

#[tokio::main]
async fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("mcp") => run_mcp().await,
        Some("native-host") => {
            let origin = std::env::args().nth(2).unwrap_or_default();
            run_native_host(origin).await
        }
        Some("ping") => run_ping(),
        _ => {
            eprintln!("usage: verboo-in-chrome <mcp|native-host|ping>");
            std::process::exit(2);
        }
    };

    if let Err(error) = result {
        eprintln!("verboo-in-chrome: {error}");
        std::process::exit(1);
    }
}
