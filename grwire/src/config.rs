//! Where GRWire keeps its token and its certificate, and how it names itself.

use std::path::{Path, PathBuf};

use rand::Rng;

pub const TOKEN_FILE: &str = "token";
pub const CERT_FILE: &str = "cert.pem";
pub const KEY_FILE: &str = "key.pem";

/// `$XDG_CONFIG_HOME/grwire`, or `~/.config/grwire`. A system install running
/// under systemd points `--config-dir` at `/var/lib/grwire` instead.
pub fn default_config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("grwire");
        }
    }
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => PathBuf::from(home).join(".config").join("grwire"),
        _ => PathBuf::from(".grwire"),
    }
}

/// Read the access token, minting one on first run.
///
/// A browser cannot set headers on a WebSocket handshake, so this travels in the
/// URL query. That is exactly why it is a per-install random secret rather than
/// a password: it ends up in shell history and in the block's saved settings,
/// and it should be cheap to rotate by deleting this file.
pub fn load_or_create_token(dir: &Path) -> anyhow::Result<String> {
    let path = dir.join(TOKEN_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    std::fs::create_dir_all(dir)?;
    let token = random_token();
    std::fs::write(&path, format!("{token}\n"))?;
    restrict(&path)?;
    Ok(token)
}

fn random_token() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// Owner-only. The token and the private key are both secrets, and a
/// world-readable `~/.config` is common enough to be worth defending against.
pub fn restrict(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(path, permissions)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Constant-time comparison. A token check that returns early leaks its length
/// and, given enough tries over a LAN, its content.
pub fn token_matches(expected: &str, given: &str) -> bool {
    use subtle::ConstantTimeEq;
    if expected.len() != given.len() {
        return false;
    }
    expected.as_bytes().ct_eq(given.as_bytes()).into()
}

/// This host's name as a browser would have to type it. `.local` is appended
/// because that is what actually resolves on a LAN with mDNS, which is how a
/// Raspberry Pi is reachable without anyone editing a hosts file.
pub fn host_names() -> Vec<String> {
    let mut names = vec!["localhost".to_string()];
    if let Ok(name) = hostname::get() {
        if let Some(name) = name.to_str() {
            let bare = name.trim().to_string();
            if !bare.is_empty() && bare != "localhost" {
                names.push(bare.clone());
                if !bare.contains('.') {
                    names.push(format!("{bare}.local"));
                }
            }
        }
    }
    names
}

/// Every address this daemon might be reached on, for the certificate's SANs and
/// for the connect URL printed at startup.
pub fn host_addresses() -> Vec<std::net::IpAddr> {
    let mut addresses = vec![
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
    ];
    if let Ok(local) = local_ip_address::local_ip() {
        if !addresses.contains(&local) {
            addresses.push(local);
        }
    }
    if let Ok(list) = local_ip_address::list_afinet_netifas() {
        for (_, address) in list {
            if !address.is_loopback() && !addresses.contains(&address) {
                addresses.push(address);
            }
        }
    }
    addresses
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_minted_once_and_then_reused() {
        let dir = std::env::temp_dir().join(format!("grwire-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = load_or_create_token(&dir).unwrap();
        let second = load_or_create_token(&dir).unwrap();
        assert_eq!(first, second, "the token must be stable across restarts");
        assert_eq!(first.len(), 32);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_comparison_rejects_the_obvious_attacks() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        // A prefix must not pass, which is what a naive starts_with would allow.
        assert!(!token_matches("abc123", "abc"));
        assert!(!token_matches("abc", "abc123"));
        assert!(!token_matches("", "x"));
    }

    #[test]
    fn host_names_always_offer_localhost() {
        let names = host_names();
        assert!(names.contains(&"localhost".to_string()));
    }

    #[test]
    fn addresses_include_loopback() {
        let addresses = host_addresses();
        assert!(addresses.iter().any(|address| address.is_loopback()));
    }
}
