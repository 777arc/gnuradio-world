//! GRWire: a remote SDR bridge for GNU Radio World.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use clap::{Parser, Subcommand};

use grwire::config;
use grwire::net::http::AppState;
use grwire::net::tls;
use grwire::proto::DEFAULT_PORT;
use grwire::session::DEFAULT_FLOW_WINDOW_MS;

#[derive(Parser)]
#[command(
    name = "grwire",
    version,
    about = "Stream a local SDR to GNU Radio World in a browser, over one WebSocket"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Where the token and certificate live.
    #[arg(long, global = true)]
    config_dir: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Serve radios to a browser (the default).
    Serve {
        /// Address to listen on.
        #[arg(long, default_value_t = format!("0.0.0.0:{DEFAULT_PORT}"))]
        listen: String,

        /// Speak plain ws:// instead of wss://.
        ///
        /// Only useful when the browser reaches this daemon at 127.0.0.1, which
        /// is the one address an HTTPS page may open an insecure socket to.
        #[arg(long)]
        insecure: bool,

        /// Allow a new client to replace one that is already connected.
        #[arg(long)]
        takeover: bool,

        /// Additional allowed browser origins.
        #[arg(long = "allow-origin")]
        allow_origins: Vec<String>,

        /// How far ahead of the client's acknowledgements to run before
        /// dropping, in milliseconds.
        #[arg(long, default_value_t = DEFAULT_FLOW_WINDOW_MS)]
        flow_window_ms: f64,
    },

    /// List the radios this host can see, then exit.
    List,

    /// Print the URL to paste into GNU Radio World, then exit.
    Url {
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        #[arg(long)]
        insecure: bool,
    },
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("GRWIRE_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();
    let dir = cli.config_dir.unwrap_or_else(config::default_config_dir);

    match cli.command.unwrap_or(Command::Serve {
        listen: format!("0.0.0.0:{DEFAULT_PORT}"),
        insecure: false,
        takeover: false,
        allow_origins: Vec::new(),
        flow_window_ms: DEFAULT_FLOW_WINDOW_MS,
    }) {
        Command::List => {
            let devices = grwire::radio::enumerate();
            if devices.is_empty() {
                println!("no radios found");
            }
            for device in devices {
                // Name first: the args string is long enough to push the useful
                // part off the edge of a terminal, and it is the label a person
                // recognises their radio by.
                println!("{}", device.label);
                println!("    {}", device.args);
            }
            Ok(())
        }

        Command::Url { port, insecure } => {
            let token = config::load_or_create_token(&dir)?;
            for url in connect_urls(port, insecure, &token) {
                println!("{url}");
            }
            Ok(())
        }

        Command::Serve {
            listen,
            insecure,
            takeover,
            allow_origins,
            flow_window_ms,
        } => {
            let address: SocketAddr = listen
                .parse()
                .map_err(|_| anyhow::anyhow!("'{listen}' is not an address:port"))?;
            let token = config::load_or_create_token(&dir)?;

            let mut origins: Vec<String> = grwire::net::http::default_origins()
                .iter()
                .map(|s| s.to_string())
                .collect();
            origins.extend(allow_origins);

            let state = AppState {
                token: token.clone(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                host: config::host_names()
                    .into_iter()
                    .nth(1)
                    .unwrap_or_else(|| "localhost".into()),
                allowed_origins: Arc::new(origins),
                flow_window_ms,
                busy: Arc::new(AtomicBool::new(false)),
                takeover,
            };

            banner(&state, address, insecure, &token, &dir);

            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            runtime.block_on(async move {
                if insecure {
                    serve_plain(address, state).await
                } else {
                    serve_tls(address, state, &dir).await
                }
            })
        }
    }
}

async fn serve_plain(address: SocketAddr, state: AppState) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, grwire::net::http::router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn serve_tls(
    address: SocketAddr,
    state: AppState,
    dir: &std::path::Path,
) -> anyhow::Result<()> {
    // rustls 0.23 refuses to guess when more than one crypto backend is
    // compiled in, and something in this dependency tree pulls aws-lc-rs in
    // beside ring. Without this the process panics on the first TLS handshake
    // -- which is to say the whole wss:// path, the only way a browser on
    // another machine can reach this daemon at all.
    //
    // Ignoring the error is deliberate: it means a provider is already
    // installed, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let identity = tls::load_or_create(dir)?;
    let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem(
        identity.certificate_pem.into_bytes(),
        identity.key_pem.into_bytes(),
    )
    .await?;

    // axum_server has no graceful-shutdown future of its own here; Ctrl-C ends
    // the process, and every session's threads are torn down by their Drop.
    axum_server::bind_rustls(address, tls_config)
        .serve(grwire::net::http::router(state).into_make_service())
        .await?;
    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

/// Every URL this daemon is plausibly reachable at, most useful first.
fn connect_urls(port: u16, insecure: bool, token: &str) -> Vec<String> {
    let scheme = if insecure { "ws" } else { "wss" };
    let mut urls = Vec::new();
    for name in config::host_names() {
        if name == "localhost" && !insecure {
            continue;
        }
        urls.push(format!("{scheme}://{name}:{port}/ws?token={token}"));
    }
    for address in config::host_addresses() {
        if address.is_loopback() && !insecure {
            continue;
        }
        let host = match address {
            std::net::IpAddr::V6(v6) => format!("[{v6}]"),
            other => other.to_string(),
        };
        urls.push(format!("{scheme}://{host}:{port}/ws?token={token}"));
    }
    urls
}

fn banner(
    state: &AppState,
    address: SocketAddr,
    insecure: bool,
    token: &str,
    dir: &std::path::Path,
) {
    let port = address.port();
    let devices = grwire::radio::enumerate();

    println!("GRWire {} on {}", state.version, state.host);
    println!("  backends: {}", grwire::radio::backends().join(", "));
    println!(
        "  radios:   {}",
        if devices.len() <= 1 {
            "none found (only the built-in fake)".to_string()
        } else {
            devices
                .iter()
                .filter(|device| device.driver != "fake")
                .map(|device| device.label.clone())
                .collect::<Vec<_>>()
                .join(", ")
        }
    );
    println!("  config:   {}", dir.display());
    println!();

    if insecure {
        println!("Serving PLAIN ws:// -- a page on https://www.gnuradioworld.com can only");
        println!("reach this at 127.0.0.1. For any other machine, drop --insecure.");
    } else {
        let name = config::host_names()
            .into_iter()
            .nth(1)
            .unwrap_or_else(|| "localhost".into());
        println!("First time from this browser: open this once and accept the warning");
        println!();
        println!("    https://{name}:{port}/");
        println!();
    }
    println!("Then paste this into GNU Radio World's GRWire Source block:");
    println!();
    for url in connect_urls(port, insecure, token) {
        println!("    {url}");
    }
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_urls_skip_loopback_and_insecure_ones_include_it() {
        // wss:// to localhost is pointless -- that is the one address plain ws
        // is allowed to -- so the banner should not suggest it.
        let secure = connect_urls(8073, false, "tok");
        assert!(secure.iter().all(|url| url.starts_with("wss://")));
        assert!(!secure.iter().any(|url| url.contains("127.0.0.1")));

        let plain = connect_urls(8073, true, "tok");
        assert!(plain.iter().all(|url| url.starts_with("ws://")));
        assert!(plain.iter().any(|url| url.contains("localhost")));
    }

    #[test]
    fn urls_carry_the_token_because_a_browser_cannot_send_a_header() {
        assert!(connect_urls(8073, true, "secret")
            .iter()
            .all(|url| url.contains("token=secret")));
    }
}
