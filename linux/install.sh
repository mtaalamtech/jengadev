#!/usr/bin/env bash
# JengaDev for Linux - installer.
#
# The only dependency is Docker; everything else (Caddy, PHP, MariaDB,
# PostgreSQL, Mailpit) runs as containers so there's nothing to compile or
# version-match against the host distro. The daemon itself is a single
# pkg-compiled binary (no Node.js needed on the host) downloaded from the
# latest GitHub release. This script: checks for Docker, installs it if
# missing (Debian/Ubuntu and Fedora/RHEL covered directly; other distros
# get a link), downloads the daemon binary, and sets up a systemd user
# service so JengaDev starts automatically on login without a terminal
# window.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DAEMON_URL="https://github.com/mtaalamtech/jengadev/releases/latest/download/jengadev-daemon-linux-x64"

echo "== JengaDev for Linux - installer =="
echo

# --- 1. Docker ---
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found."
  if [ -f /etc/debian_version ]; then
    echo "Installing Docker Engine (Debian/Ubuntu)..."
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update -qq
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif [ -f /etc/redhat-release ]; then
    echo "Installing Docker Engine (Fedora/RHEL)..."
    sudo dnf -y install dnf-plugins-core
    sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
    sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    echo "Please install Docker manually: https://docs.docker.com/engine/install/"
    exit 1
  fi
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER"
  echo
  echo "Docker installed. You've been added to the 'docker' group - log out and"
  echo "back in once, then re-run this script."
  exit 0
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker is installed but the Compose plugin is missing."
  echo "Install docker-compose-plugin for your distro, then re-run this script."
  exit 1
fi

if ! docker ps >/dev/null 2>&1; then
  echo "Docker is installed but not usable by this user yet."
  echo "Run: sudo usermod -aG docker \$USER, then log out and back in (a plain"
  echo "'newgrp docker' isn't enough - see the troubleshooting note below)."
  exit 1
fi

echo "Docker OK ($(docker --version))"

# --- 2. Daemon binary ---
if [ ! -f jengadev-daemon ] || [ "${1:-}" = "--upgrade" ]; then
  echo "Downloading the JengaDev daemon..."
  curl -fsSL "$DAEMON_URL" -o jengadev-daemon
  chmod +x jengadev-daemon
fi
echo "Daemon binary ready."

# --- 3. Postgres needs a password on first run - generate one if the
# project .env doesn't have one yet, same spirit as the Windows build no
# longer shipping Postgres with trust auth. ---
if [ ! -f .env ] || ! grep -q '^POSTGRES_PASSWORD=' .env 2>/dev/null; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 18)" >> .env
fi

mkdir -p www config logs/php
# Docker creates a bind-mount source as a directory if nothing exists there
# yet - Caddy expects a *file* at /etc/caddy/Caddyfile, so touch one into
# existence before `docker compose up` ever tries to mount it. The daemon
# overwrites it with real content once it starts.
[ -f config/Caddyfile ] || touch config/Caddyfile
# Same bind-mount-becomes-a-directory risk applies to the per-host PHP error
# log router files mounted into the php81/82/83 containers - only matters if
# a php service gets started before the daemon has run once to write real
# content, but cheap to guard against regardless.
[ -f config/php_error_router.php ] || touch config/php_error_router.php
[ -f config/php-error-router.ini ] || touch config/php-error-router.ini
# Same again for MariaDB's custom my.cnf overlay.
[ -f config/mysql-custom.cnf ] || touch config/mysql-custom.cnf
# Same again for Mailpit's SMTP auth file.
[ -f config/mailpit_auth.txt ] || touch config/mailpit_auth.txt

# --- 4. Start Caddy up front so the dashboard's reverse-proxy and *.localhost
# routing work immediately; other services start on demand from the dashboard. ---
docker compose up -d --build caddy

# --- 5. Run the daemon as a systemd --user service - starts automatically on
# login, no terminal window, survives logout via linger. ---
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/jengadev.service" <<EOF
[Unit]
Description=JengaDev daemon

[Service]
ExecStart=$SCRIPT_DIR/jengadev-daemon
WorkingDirectory=$SCRIPT_DIR
Restart=on-failure

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now jengadev.service
loginctl enable-linger "$USER" 2>/dev/null || true

# If Docker group membership was granted earlier in this *same* shell
# session (rather than a session that started after the grant), the
# systemd --user manager can still be running with the old, docker-less
# group list even though `docker` works fine interactively here - so the
# daemon it spawns silently can't see any containers. Caddy is already up
# from the step above, so ask the freshly-started daemon about it: if it
# says "stopped" when we know it isn't, that's exactly this problem.
sleep 2
TOKEN_FILE="$SCRIPT_DIR/config/daemon_token.txt"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
  CADDY_STATE="$(curl -s http://127.0.0.1:4000/api/status -H "X-JengaDev-Token: $TOKEN" | grep -o '"caddy":"[a-z]*"' || true)"
  if echo "$CADDY_STATE" | grep -q '"stopped"'; then
    echo
    echo "JengaDev is running, but its view of Docker looks stale (this happens if"
    echo "you were added to the 'docker' group earlier in this same terminal session)."
    echo "Log out and back in once, then it'll pick up the services correctly -"
    echo "no need to re-run this script."
  fi
fi

echo
echo "JengaDev is running."
if [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "Dashboard: http://127.0.0.1:4000/?token=$TOKEN"
  if [ -n "$LAN_IP" ]; then
    echo "From another device on this network: http://$LAN_IP:4000/?token=$TOKEN"
    echo "(if that doesn't load, this machine's firewall may be blocking port 4000 -"
    echo "that's something only you should open, this script won't touch firewall rules)"
  fi
else
  echo "Couldn't find the daemon token yet - check: journalctl --user -u jengadev -n 20"
fi
