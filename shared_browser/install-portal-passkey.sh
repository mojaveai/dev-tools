#!/bin/sh
set -eu
cd "$(dirname "$0")"
runtime_dir=$(pwd)
node_path=$(command -v node)
# Pin this test adapter to the inspected, already-installed QA edge implementation.
identity_source=/nix/store/qpm45zwipnbf9aj09cv62avrc4lbjpy0-agent-trace-qa-source/deploy/qa/identity.py
python_path=/nix/store/n80fxq3p0669fwib4cv54z9d5jg0mhi8-python3-3.12.12-env/bin/python3
"$python_path" portal-passkey-edge.py "$identity_source" --help >/dev/null
npm run build
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/dev-tools-portal-passkey.service" <<UNIT
[Unit]
Description=Existing dev portal passkey handoff for shared Chrome
After=dev-tools-shared-browser.service
[Service]
Type=simple
WorkingDirectory=$runtime_dir
ExecStart=$node_path $runtime_dir/portal-passkey-bridge.mjs
UMask=0077
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now dev-tools-portal-passkey.service
sudo install -d -m 0755 /usr/local/lib/dev-tools-shared-browser
sudo install -m 0644 portal-passkey-edge.py /usr/local/lib/dev-tools-shared-browser/portal-passkey-edge.py
sudo mkdir -p /etc/systemd/system/agent-trace-qa-identity-dashboard.service.d
cat > /tmp/shared-browser-passkey-edge.conf <<UNIT
# Shared-browser test adapter; remove this drop-in to restore the original QA edge.
[Service]
ExecStart=
ExecStart=$python_path /usr/local/lib/dev-tools-shared-browser/portal-passkey-edge.py $identity_source dashboard --config %d/CONFIG
UNIT
sudo install -m 0644 /tmp/shared-browser-passkey-edge.conf /etc/systemd/system/agent-trace-qa-identity-dashboard.service.d/90-shared-browser-passkey.conf
sudo systemctl daemon-reload
sudo systemctl restart agent-trace-qa-identity-dashboard.service
