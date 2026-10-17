#!/usr/bin/env bash
# Prepare the engine server (Ubuntu 24.04 arm64, Oracle Always Free). Safe to
# re-run. Expects the env file's contents on stdin (SUPABASE_ACCESS_TOKEN and
# ENGINE_PROJECT_REF). Installs Node 22, git, the two repos and the systemd
# units and the keep-warm service; does NOT enable the hourly timer
# (engine-server.yml "enable" does).
set -euo pipefail
ENVFILE_CONTENT="$(cat)"
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || ! node -v | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  sudo -E bash /tmp/nodesource_setup.sh >/dev/null
  sudo apt-get install -y -q nodejs >/dev/null
fi
command -v git >/dev/null || sudo apt-get install -y -q git >/dev/null
sudo mkdir -p /opt/dhq && sudo chown ubuntu:ubuntu /opt/dhq
[ -d /opt/dhq/app/.git ] || git clone -q https://github.com/skjjcruz/github.com-skjjcruz-owner-dashboard-dev.git /opt/dhq/app
[ -d /opt/dhq/DHQ-Shared/.git ] || git clone -q https://github.com/skjjcruz/DHQ-Shared.git /opt/dhq/DHQ-Shared
git -C /opt/dhq/app fetch -q origin main && git -C /opt/dhq/app reset -q --hard origin/main
printf '%s\n' "$ENVFILE_CONTENT" | sudo tee /etc/dhq-engine.env >/dev/null
sudo chown root:ubuntu /etc/dhq-engine.env && sudo chmod 640 /etc/dhq-engine.env
sudo install -m 644 /opt/dhq/app/server/engine/host/dhq-engine.service /etc/systemd/system/dhq-engine.service
sudo install -m 644 /opt/dhq/app/server/engine/host/dhq-engine.timer /etc/systemd/system/dhq-engine.timer
sudo install -m 644 /opt/dhq/app/server/engine/host/dhq-keepwarm.service /etc/systemd/system/dhq-keepwarm.service
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=300M\n' | sudo tee /etc/systemd/journald.conf.d/dhq.conf >/dev/null
sudo systemctl restart systemd-journald
sudo systemctl daemon-reload
echo "node $(node -v), git $(git --version | cut -d' ' -f3), app at $(git -C /opt/dhq/app rev-parse --short HEAD)"
sudo systemctl enable -q dhq-keepwarm.service && sudo systemctl restart dhq-keepwarm.service
echo "timer: $(systemctl is-enabled dhq-engine.timer 2>/dev/null || true)"
echo "keep-warm: $(systemctl is-active dhq-keepwarm.service)"
echo "oracle monitoring agent: $(systemctl is-active snap.oracle-cloud-agent.oracle-cloud-agent.service 2>/dev/null || echo unknown)"
free -m | head -2
