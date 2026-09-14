#!/bin/sh
set -eu
cd "$(dirname "$0")"
runtime_dir=$(pwd)
node_path=$(command -v node)
chrome_path=${SHARED_BROWSER_CHROME:-}
if [ -z "$chrome_path" ] && [ -f "$HOME/.config/dev-tools/browser.json" ]; then
  chrome_path=$(python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/".config/dev-tools/browser.json").read_text()).get("chromium", ""))')
fi
if [ -z "$chrome_path" ]; then chrome_path=$(command -v google-chrome || command -v chromium); fi
npm ci
npm run build
mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/state/dev-tools/shared-browser"
chmod 700 "$HOME/.local/state/dev-tools/shared-browser"
cat > "$HOME/.config/systemd/user/dev-tools-shared-browser.service" <<EOF
[Unit]
Description=Persistent DOM shared Chrome pilot
After=network.target

[Service]
Type=simple
WorkingDirectory=$runtime_dir
ExecStart=$node_path $runtime_dir/server.mjs
Environment=SHARED_BROWSER_CHROME=$chrome_path
Environment=SHARED_BROWSER_ORIGIN=https://procbox.agent-trace.ts.net:8443
Environment=SHARED_BROWSER_OWNER=manbir@asgroup.ai
UMask=0077
KillMode=mixed
TimeoutStopSec=20
Restart=no

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now dev-tools-shared-browser.service
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/dev-tools-shared-browser" <<EOF
#!/bin/sh
exec "$node_path" "$runtime_dir/cli.mjs" "\$@"
EOF
chmod 755 "$HOME/.local/bin/dev-tools-shared-browser"
echo "Installed. Verify readiness, then publish the dedicated Tailscale Serve port 8443."
