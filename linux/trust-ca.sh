#!/usr/bin/env bash
# Trusts JengaDev's local HTTPS certificate authority on this machine, so
# https://<name>.localhost sites open without browser warnings.
#
# Caddy (in the jengadev_caddy container) issues a certificate for every
# host from its own local root CA. This copies that root CA out of the
# container and adds it to:
#   - the system trust store (curl, wget, PHP, most CLI tools)
#   - the NSS databases Chrome/Chromium and Firefox use on Linux
# Safe to re-run: an existing "JengaDev Local CA" entry is replaced.
#
# If your browser runs on a different machine (headless dev server), use
# the dashboard's SSL Tools -> "Download certificate" instead and import it
# there.
set -euo pipefail

NAME="JengaDev Local CA"
CA_IN_CONTAINER="/data/caddy/pki/authorities/local/root.crt"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! docker exec jengadev_caddy cat "$CA_IN_CONTAINER" > "$TMP" 2>/dev/null || ! grep -q "BEGIN CERTIFICATE" "$TMP"; then
  echo "Couldn't read the local CA from the Caddy container."
  echo "Make sure JengaDev's Web Server (Caddy) is running and you've created at least one host, then re-run this."
  exit 1
fi

# --- System trust store ---
if [ -d /usr/local/share/ca-certificates ]; then
  sudo cp "$TMP" /usr/local/share/ca-certificates/jengadev-local-ca.crt
  sudo update-ca-certificates >/dev/null
  echo "Added to the system trust store (Debian/Ubuntu)."
elif [ -d /etc/pki/ca-trust/source/anchors ]; then
  sudo cp "$TMP" /etc/pki/ca-trust/source/anchors/jengadev-local-ca.crt
  sudo update-ca-trust
  echo "Added to the system trust store (Fedora/RHEL)."
else
  echo "Unknown system trust store layout - skipped (browsers below are still handled)."
fi

# --- Browser NSS databases (Chrome/Chromium, Firefox) ---
if ! command -v certutil >/dev/null 2>&1; then
  echo
  echo "Browsers not updated: 'certutil' is missing. Install it, then re-run this script:"
  echo "  Debian/Ubuntu: sudo apt-get install libnss3-tools"
  echo "  Fedora/RHEL:   sudo dnf install nss-tools"
  exit 0
fi

add_to_nssdb() {
  local db="$1" label="$2"
  certutil -d "sql:$db" -D -n "$NAME" >/dev/null 2>&1 || true
  certutil -d "sql:$db" -A -t "C,," -n "$NAME" -i "$TMP"
  echo "Added to $label ($db)."
}

# Chrome/Chromium
mkdir -p "$HOME/.pki/nssdb"
[ -f "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password
add_to_nssdb "$HOME/.pki/nssdb" "Chrome/Chromium"

# Firefox (regular and Snap installs)
found_ff=0
for profile in "$HOME"/.mozilla/firefox/*/ "$HOME"/snap/firefox/common/.mozilla/firefox/*/; do
  if [ -f "${profile}cert9.db" ]; then
    add_to_nssdb "${profile%/}" "Firefox profile"
    found_ff=1
  fi
done
[ "$found_ff" = 1 ] || echo "No Firefox profile found - skipped Firefox."

echo
echo "Done. Restart your browser, then open https://<name>.localhost."
