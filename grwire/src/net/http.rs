//! The HTTP surface: a human trust page, a machine `/info`, and `/ws`.
//!
//! All three share one port so that the URL a user accepts the certificate at is
//! the same host and port the WebSocket then connects to -- which is what makes
//! the grant apply.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Json;
use serde::Deserialize;

use crate::config::token_matches;
use crate::net::ws::{self, SocketConfig};

#[derive(Clone)]
pub struct AppState {
    pub token: String,
    pub version: String,
    pub host: String,
    pub allowed_origins: Arc<Vec<String>>,
    pub flow_window_ms: f64,
    /// One client at a time. A radio is not shareable, and interleaving two
    /// clients' tuning requests would produce a stream that matches neither.
    pub busy: Arc<AtomicBool>,
    pub takeover: bool,
}

/// Origins allowed out of the box: the deployed site, its PR previews, and a
/// local development server. Anything else needs --allow-origin.
pub fn default_origins() -> &'static [&'static str] {
    &[
        "https://gnuradioworld.com",
        "https://www.gnuradioworld.com",
        "https://*.pages.dev",
        "http://localhost:8090",
        "http://127.0.0.1:8090",
    ]
}

pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/", get(trust_page))
        .route("/info", get(info).options(preflight))
        // OPTIONS must be its own handler, not folded into the upgrade one:
        // axum's WebSocketUpgrade extractor rejects anything that is not a GET
        // before the handler body runs, so a preflight answered there comes back
        // 405 and Chrome refuses the connection before it starts. Found by
        // sending Chrome's own preflight at it from another machine.
        .route("/ws", get(websocket).options(preflight))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct ConnectQuery {
    #[serde(default)]
    token: String,
}

/// Chrome applies Private/Local Network Access checks to requests from a public
/// origin (the GNU Radio World site) to a private address (this daemon),
/// including the WebSocket handshake. Answering the preflight is what keeps the
/// connection from being refused before it starts.
fn local_network_headers(origin: Option<&HeaderValue>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(origin) = origin {
        headers.insert("access-control-allow-origin", origin.clone());
    }
    headers.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("*"),
    );
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, OPTIONS"),
    );
    headers
}

fn origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin").and_then(|value| value.to_str().ok()) else {
        // No Origin at all means a non-browser client -- curl, the probe tool,
        // a test. The token is the check that matters for those.
        return true;
    };

    // A page this daemon served itself is always allowed. Refusing it was a
    // real bug: the trust page could not open a socket to the very daemon that
    // sent it, which is the most obvious thing a person tries first.
    if let Some(host) = headers.get("host").and_then(|value| value.to_str().ok()) {
        if origin
            .strip_prefix("https://")
            .or_else(|| origin.strip_prefix("http://"))
            .is_some_and(|origin_host| origin_host == host)
        {
            return true;
        }
    }

    state.allowed_origins.iter().any(|allowed| {
        allowed == "*"
            || allowed == origin
            // One wildcard form, for the PR-preview domains.
            || allowed
                .strip_prefix("https://*.")
                .map(|suffix| {
                    origin
                        .strip_prefix("https://")
                        .map(|host| host.ends_with(suffix))
                        .unwrap_or(false)
                })
                .unwrap_or(false)
    })
}

/// Answers the CORS / Local Network Access preflight a browser sends before it
/// is willing to reach a private address from a public page.
async fn preflight(headers: HeaderMap) -> Response {
    (
        StatusCode::NO_CONTENT,
        local_network_headers(headers.get("origin")),
    )
        .into_response()
}

async fn info(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let body = serde_json::json!({
        "service": "grwire",
        "protocol": crate::proto::PROTOCOL,
        "version": state.version,
        "host": state.host,
        "backends": crate::radio::backends(),
        "busy": state.busy.load(Ordering::Acquire),
    });
    (local_network_headers(headers.get("origin")), Json(body)).into_response()
}

async fn websocket(
    State(state): State<AppState>,
    Query(query): Query<ConnectQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&state, &headers) {
        let origin = headers
            .get("origin")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("unknown");
        tracing::warn!("refused a connection from origin {origin}");
        return (
            StatusCode::FORBIDDEN,
            format!("origin {origin} is not allowed; pass --allow-origin to permit it"),
        )
            .into_response();
    }

    if !token_matches(&state.token, &query.token) {
        tracing::warn!("refused a connection with a bad token");
        return (
            StatusCode::UNAUTHORIZED,
            "bad or missing token; use the URL grwire printed at startup",
        )
            .into_response();
    }

    if state
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        if !state.takeover {
            return (
                StatusCode::CONFLICT,
                "another client is already connected to this radio (start grwire with --takeover to allow replacing it)",
            )
                .into_response();
        }
        tracing::info!("--takeover: replacing the existing client");
    }

    let busy = state.busy.clone();
    let config = SocketConfig {
        flow_window_ms: state.flow_window_ms,
        version: state.version.clone(),
        host: state.host.clone(),
    };
    upgrade
        .protocols([crate::proto::SUBPROTOCOL])
        .on_upgrade(move |socket| async move {
            ws::serve(socket, config).await;
            busy.store(false, Ordering::Release);
        })
}

/// The page the user lands on when they accept the certificate.
///
/// This exists because the alternative is a browser security interstitial with
/// no explanation, at a URL the user was told to visit by a flowgraph editor.
/// Reaching a page that names the thing and says what to do next is the whole
/// difference between "this is broken" and "right, one click".
async fn trust_page(State(state): State<AppState>, headers: HeaderMap) -> Html<String> {
    // The Host header, not this daemon's idea of its own name: the user may
    // have reached it by IP, by hostname or by .local, and the line they need
    // to copy is the one matching what is in their address bar.
    let host_header = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("this address")
        .to_string();
    let port = host_header
        .rsplit_once(':')
        .map(|(_, port)| port.to_string())
        .unwrap_or_else(|| crate::proto::DEFAULT_PORT.to_string());
    let host = &state.host;
    let version = &state.version;
    let backends = crate::radio::backends().join(", ");
    let radios = crate::radio::enumerate()
        .into_iter()
        .map(|device| {
            // The name a person recognises, with the args string underneath as
            // the thing they actually paste. The other way round reads as a
            // wall of key=value.
            format!(
                "<li><strong>{}</strong><br><code>{}</code></li>",
                html_escape(&device.label),
                html_escape(&device.args)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    Html(format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GRWire on {host}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; }}
  h1 {{ font-size: 1.5rem; margin-bottom: .25rem; }}
  .sub {{ color: #666; margin-top: 0; }}
  .ok {{ background: #e8f5e9; border-left: 4px solid #43a047; padding: .75rem 1rem;
         border-radius: 4px; }}
  @media (prefers-color-scheme: dark) {{ .ok {{ background: #1b3a1e; }} .sub {{ color: #aaa; }} }}
  code {{ background: rgba(128,128,128,.18); padding: .1rem .35rem; border-radius: 3px; }}
  ul {{ padding-left: 1.2rem; }}
  li {{ margin-bottom: .5rem; }}
  li code {{ font-size: .8em; opacity: .8; }}
  pre {{ background: rgba(128,128,128,.12); padding: .6rem .8rem; border-radius: 4px;
         overflow-x: auto; }}
  footer {{ margin-top: 2.5rem; font-size: .875rem; color: #777; }}
</style>
</head>
<body>
<h1>GRWire is running on {host}</h1>
<p class="sub">Version {version} &middot; backends: {backends}</p>

<div class="ok">
  <strong>The certificate is now accepted.</strong>
  Go back to GNU Radio World and press <em>Connect</em> again &mdash; this browser
  will remember this daemon from now on.
</div>

<h2>The URL to paste into the block</h2>
<p>
  It is <em>not</em> on this page, on purpose: anyone who can reach this address
  could then read the access token, and the token is the only thing protecting
  the radio. It was printed in the terminal that started GRWire, under
  &ldquo;Then paste this into GNU Radio World&rsquo;s GRWire Source block&rdquo;.
</p>
<p>To print it again, on the machine running GRWire:</p>
<pre><code>grwire url --port {port}</code></pre>
<p class="sub">
  Pick the line whose host matches the address you are reading this page at
  &mdash; <code>{host_header}</code>.
</p>

<h2>Why the warning?</h2>
<p>
  GNU Radio World runs on <code>https://</code>, and a secure page is not allowed
  to open an insecure connection to your local network. So GRWire encrypts its
  own traffic &mdash; but no certificate authority will vouch for a name like
  <code>{host}</code> on a private network, so it signs its own certificate and
  you approve it once, here.
</p>

<h2>Radios this daemon can see</h2>
<ul>
{radios}
</ul>
<p class="sub">
  One radio can appear twice &mdash; the same hardware reached through SoapySDR
  and through a built-in driver. They are alternatives, not two radios; prefer
  the SoapySDR one. Sound cards are listed because SoapySDR exposes them, not
  because they are useful here.
</p>

<footer>
  GRWire is part of <a href="https://www.gnuradioworld.com/">GNU Radio World</a>.
  It streams IQ from this machine to one browser at a time.
</footer>
</body>
</html>
"#
    ))
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with(origins: Vec<&str>) -> AppState {
        AppState {
            token: "t".into(),
            version: "0.1.0".into(),
            host: "testhost".into(),
            allowed_origins: Arc::new(origins.into_iter().map(String::from).collect()),
            flow_window_ms: 250.0,
            busy: Arc::new(AtomicBool::new(false)),
            takeover: false,
        }
    }

    fn headers_with_origin(origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_str(origin).unwrap());
        headers
    }

    #[test]
    fn the_site_is_allowed_and_a_stranger_is_not() {
        let state = state_with(vec!["https://www.gnuradioworld.com"]);
        assert!(origin_allowed(
            &state,
            &headers_with_origin("https://www.gnuradioworld.com")
        ));
        assert!(!origin_allowed(
            &state,
            &headers_with_origin("https://evil.example")
        ));
    }

    #[test]
    fn a_wildcard_matches_only_within_its_suffix() {
        let state = state_with(vec!["https://*.pages.dev"]);
        assert!(origin_allowed(
            &state,
            &headers_with_origin("https://pr-7.pages.dev")
        ));
        // The suffix must not match a lookalike registered elsewhere.
        assert!(!origin_allowed(
            &state,
            &headers_with_origin("https://pages.dev.evil.example")
        ));
        // And it must not downgrade to http.
        assert!(!origin_allowed(
            &state,
            &headers_with_origin("http://pr-7.pages.dev")
        ));
    }

    /// The daemon's own trust page must be able to reach it. It could not:
    /// the origin allowlist named only the public site, so the page GRWire
    /// itself serves was refused by GRWire.
    #[test]
    fn a_page_this_daemon_served_is_always_allowed() {
        let state = state_with(vec!["https://gnuradioworld.com"]);
        let mut headers = headers_with_origin("https://172.21.238.36:8073");
        headers.insert("host", HeaderValue::from_static("172.21.238.36:8073"));
        assert!(origin_allowed(&state, &headers));

        // But a *different* host claiming that origin is still refused.
        let mut elsewhere = headers_with_origin("https://172.21.238.36:8073");
        elsewhere.insert("host", HeaderValue::from_static("192.168.1.9:8073"));
        assert!(!origin_allowed(&state, &elsewhere));
    }

    /// The real site, spelled the way it is actually spelled. This was wrong
    /// for the life of the first implementation and every browser connection
    /// from the deployed site was refused because of it.
    #[test]
    fn the_deployed_site_is_allowed_by_default() {
        let state = AppState {
            token: "t".into(),
            version: "0.1.0".into(),
            host: "testhost".into(),
            allowed_origins: Arc::new(
                crate::net::http::default_origins()
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            ),
            flow_window_ms: 250.0,
            busy: Arc::new(AtomicBool::new(false)),
            takeover: false,
        };
        for origin in ["https://gnuradioworld.com", "https://www.gnuradioworld.com"] {
            assert!(
                origin_allowed(&state, &headers_with_origin(origin)),
                "{origin} must be allowed out of the box"
            );
        }
        assert!(!origin_allowed(
            &state,
            &headers_with_origin("https://evil.example")
        ));
    }

    #[test]
    fn a_client_with_no_origin_is_left_to_the_token() {
        // curl, the probe tool and the tests send no Origin. Rejecting those
        // would make the daemon untestable without a browser.
        let state = state_with(vec!["https://www.gnuradioworld.com"]);
        assert!(origin_allowed(&state, &HeaderMap::new()));
    }

    #[test]
    fn the_preflight_answers_the_local_network_check() {
        let origin = HeaderValue::from_static("https://www.gnuradioworld.com");
        let headers = local_network_headers(Some(&origin));
        assert_eq!(
            headers.get("access-control-allow-private-network").unwrap(),
            "true"
        );
        assert_eq!(headers.get("access-control-allow-origin").unwrap(), &origin);
    }

    #[test]
    fn the_trust_page_escapes_device_text() {
        assert_eq!(html_escape("<script>"), "&lt;script&gt;");
    }
}
