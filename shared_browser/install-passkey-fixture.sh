#!/bin/sh
set -eu
cd "$(dirname "$0")"
runtime_dir=$(pwd)
node_path=$(command -v node)
"$node_path" -e 'if(Number(process.versions.node.split(".")[0])<22)throw Error("Node 22 or newer is required")'
npm ci
npm run build
mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/state/dev-tools/passkey-fixture"
chmod 700 "$HOME/.local/state/dev-tools/passkey-fixture"
cat > "$HOME/.config/systemd/user/dev-tools-passkey-fixture.service" <<UNIT
[Unit]
Description=Private shared-browser passkey approval test fixture
After=network.target
[Service]
Type=simple
WorkingDirectory=$runtime_dir
ExecStart=$node_path $runtime_dir/passkey-fixture.mjs
Environment=PASSKEY_PORT=8795
Environment=PASSKEY_ORIGIN=https://procbox.agent-trace.ts.net:8443
Environment=SHARED_BROWSER_OWNER=manbir@asgroup.ai
UMask=0077
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now dev-tools-passkey-fixture.service
echo 'Fixture started. Publish only the /passkey path on the existing owner-only Tailscale viewer port.'
