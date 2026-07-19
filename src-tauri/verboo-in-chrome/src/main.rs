use verboo_in_chrome::{run_mcp, run_native_host, run_ping};

#[tokio::main]
async fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match arguments.first().map(String::as_str) {
        Some("mcp") => run_mcp().await,
        Some("native-host") => {
            let origin = arguments.get(1).cloned().unwrap_or_default();
            run_native_host(origin).await
        }
        Some("ping") => run_ping(),
        Some(origin) if origin.starts_with("chrome-extension://") => {
            // Chrome invokes a Native Messaging host with the extension origin
            // as argv[1]. On Windows a documented --parent-window argument may
            // follow; it is intentionally ignored.
            run_native_host(origin.to_string()).await
        }
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
