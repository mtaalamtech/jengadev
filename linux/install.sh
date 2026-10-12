#!/usr/bin/env bash
# JengaDev for Linux - installer.
#
# The only real dependency is Docker; everything else (Caddy, PHP,
# MariaDB, PostgreSQL, Mailpit) runs as containers so there's nothing to
# compile or version-match against the host distro. This script: checks
# for Docker, installs it if missing (Debian/Ubuntu and Fedora/RHEL
# covered directly; other distros get a link), checks for Node.js (needed
# to run the daemon itself - a precompiled binary is a later step),
# installs daemon dependencies, and sets up a systemd user service so
# JengaDev starts automatically on login without a terminal window.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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
  echo "back in (or run 'newgrp docker') once, then re-run this script."
  exit 0
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker is installed but the Compose plugin is missing."
  echo "Install docker-compose-plugin for your distro, then re-run this script."
  exit 1
fi

if ! docker ps >/dev/null 2>&1; then
  echo "Docker is installed but not usable by this user yet."
  echo "Run: sudo usermod -aG docker \$USER && newgrp docker"
  echo "...then re-run this script."
  exit 1
fi

echo "Docker OK ($(docker --version))"

# --- 2. Node.js (to run the daemon) ---
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found - installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node.js OK ($(node --version))"

# --- 3. Daemon dependencies ---
echo "Installing daemon dependencies..."
(cd daemon && npm install --omit=dev --no-audit --no-fund --silent)

# --- 4. Postgres needs a password on first run - generate one if the
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

# --- 5. Start Caddy up front so the dashboard's reverse-proxy and *.localhost
# routing work immediately; other services start on demand from the dashboard. ---
docker compose up -d --build caddy

# --- 6. Run the daemon as a systemd --user service - starts automatically on
# login, no terminal window, survives logout via linger. ---
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/jengadev.service" <<EOF
[Unit]
Description=JengaDev daemon

[Service]
ExecStart=$(command -v node) $SCRIPT_DIR/daemon/index.js
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
echo "JengaDev is running. Dashboard: http://127.0.0.1:4000"
echo "(It should have opened automatically; if not, open that URL - the"
echo "daemon prints a one-time tokenized link to its own log on first run:"
echo "  journalctl --user -u jengadev -n 20)"
