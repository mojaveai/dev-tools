#!/bin/sh
set -eu
cd "$(dirname "$0")"
runtime_dir=$(pwd)
node_path=${SHARED_BROWSER_NODE:-$(command -v node)}
"$node_path" -e 'if(Number(process.versions.node.split(".")[0])<22)throw Error("Shared browser requires Node 22 or newer; set SHARED_BROWSER_NODE")'
PATH="$(dirname "$node_path"):$PATH"
export PATH
browser_origin=${SHARED_BROWSER_ORIGIN:-}
if [ -z "$browser_origin" ]; then
    browser_dns=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
    browser_origin="https://$browser_dns:8443"
fi
browser_owner=${SHARED_BROWSER_OWNER:-manbir@asgroup.ai}
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
Environment=SHARED_BROWSER_ORIGIN=$browser_origin
Environment=SHARED_BROWSER_OWNER=$browser_owner
UMask=0077
KillMode=mixed
TimeoutStopSec=20
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now dev-tools-shared-browser.service
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/dev-tools-shared-browser" <<EOF
#!/bin/sh
if [ "\${1:-}" = mcp ]; then
    exec "$node_path" "$runtime_dir/mcp.mjs"
fi
exec "$node_path" "$runtime_dir/cli.mjs" "\$@"
EOF
chmod 755 "$HOME/.local/bin/dev-tools-shared-browser"
repo_dir=${SHARED_BROWSER_REPO:-$(dirname "$runtime_dir")}
if [ ! -f "$repo_dir/native_browser/configure.py" ]; then repo_dir="$HOME/.local/share/dev-tools"; fi
python3 "$repo_dir/shared_browser/configure.py" "$repo_dir" "$runtime_dir" "$node_path"
systemctl --user disable --now dev-tools-native-browser-repair.path dev-tools-native-browser-repair.service 2>/dev/null || true
echo "Installed. Verify readiness, then publish the dedicated Tailscale Serve port 8443."
