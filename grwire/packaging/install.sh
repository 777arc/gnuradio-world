#!/bin/sh
# Install GRWire and its service on a Debian or Ubuntu host (including a
# Raspberry Pi). Run from a built checkout: sh packaging/install.sh
set -eu

BINARY=${1:-target/release/grwire}
if [ ! -x "$BINARY" ]; then
  echo "no binary at $BINARY -- build it first with: cargo build --release" >&2
  exit 1
fi

echo "GRWire needs SoapySDR and the driver module for your radio."
echo "If you have not installed them:"
echo "  sudo apt install libsoapysdr0.8 soapysdr-module-rtlsdr soapysdr-module-hackrf"
echo

sudo install -m 0755 "$BINARY" /usr/local/bin/grwire
sudo useradd --system --no-create-home --shell /usr/sbin/nologin grwire 2>/dev/null || true
sudo usermod -aG plugdev grwire 2>/dev/null || true
sudo install -m 0644 packaging/grwire.service /etc/systemd/system/grwire.service
sudo systemctl daemon-reload
sudo systemctl enable --now grwire

echo
echo "GRWire is running. Its connect URL, including the token, is in the log:"
echo "  sudo journalctl -u grwire -n 30"
