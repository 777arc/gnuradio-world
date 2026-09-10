//! The self-signed certificate, and why there is one at all.
//!
//! GNU Radio World is served over HTTPS, and an HTTPS page may not open a plain
//! `ws://` socket to a LAN address -- Chrome blocks it as mixed content, with an
//! exception only for `127.0.0.1` and `localhost`. So a daemon on a Raspberry Pi
//! across the room is unreachable from the tab unless it terminates TLS itself.
//!
//! There is no certificate authority that will issue for `raspberrypi.local` or
//! `192.168.1.42`, so the certificate is self-signed and the user accepts it
//! once, in a browser tab, at the URL the daemon prints on startup. After that
//! the grant is remembered per browser profile and `wss://` simply works.
//!
//! The certificate is persisted rather than regenerated per run: a new one every
//! restart would mean accepting the warning every restart.

use std::path::Path;

use crate::config::{restrict, CERT_FILE, KEY_FILE};

pub struct Identity {
    pub certificate_pem: String,
    pub key_pem: String,
    /// The names the certificate is valid for, for the startup banner.
    pub names: Vec<String>,
}

/// Load the stored certificate, generating one on first run.
///
/// Regenerates when the set of names has changed -- a Pi that moved to a new
/// network needs its new address in the SANs, and a certificate that silently
/// stopped covering the address the user types is worse than a slow start.
pub fn load_or_create(dir: &Path) -> anyhow::Result<Identity> {
    let mut names = crate::config::host_names();
    for address in crate::config::host_addresses() {
        names.push(address.to_string());
    }
    names.sort();
    names.dedup();

    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);
    let names_path = dir.join("cert.names");
    let wanted = names.join("\n");

    if let (Ok(certificate_pem), Ok(key_pem), Ok(stored)) = (
        std::fs::read_to_string(&cert_path),
        std::fs::read_to_string(&key_path),
        std::fs::read_to_string(&names_path),
    ) {
        if stored.trim() == wanted.trim() {
            return Ok(Identity {
                certificate_pem,
                key_pem,
                names,
            });
        }
        tracing::info!("this host's addresses changed; issuing a new certificate");
    }

    let mut params = rcgen::CertificateParams::new(names.clone())?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "GRWire");
    params
        .distinguished_name
        .push(rcgen::DnType::OrganizationName, "GNU Radio World");
    let key = rcgen::KeyPair::generate()?;
    let certificate = params.self_signed(&key)?;

    let certificate_pem = certificate.pem();
    let key_pem = key.serialize_pem();

    std::fs::create_dir_all(dir)?;
    std::fs::write(&cert_path, &certificate_pem)?;
    std::fs::write(&key_path, &key_pem)?;
    std::fs::write(&names_path, &wanted)?;
    restrict(&key_path)?;

    Ok(Identity {
        certificate_pem,
        key_pem,
        names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_certificate_is_generated_once_and_then_reused() {
        let dir = std::env::temp_dir().join(format!("grwire-tls-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let first = load_or_create(&dir).unwrap();
        assert!(first.certificate_pem.contains("BEGIN CERTIFICATE"));
        assert!(!first.key_pem.is_empty());

        // Stable across restarts, or the user re-accepts the browser warning
        // every single time the daemon is restarted.
        let second = load_or_create(&dir).unwrap();
        assert_eq!(first.certificate_pem, second.certificate_pem);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_certificate_covers_localhost_and_this_host() {
        let dir = std::env::temp_dir().join(format!("grwire-tls-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let identity = load_or_create(&dir).unwrap();
        assert!(identity.names.contains(&"localhost".to_string()));
        assert!(
            identity.names.iter().any(|name| name == "127.0.0.1"),
            "the loopback address must be a SAN: {:?}",
            identity.names
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
