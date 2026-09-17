#!/bin/sh
set -eu
cd "$(dirname "$0")"
runtime_dir=$(pwd)
# Fail before downloads, builds, or stopping an existing browser. Many Coder
# containers do not run a user service manager even when systemctl is installed.
service_backend=systemd
if ! systemctl --user show-environment >/dev/null 2>&1; then
    service_backend=supervisor
    command -v supervisord >/dev/null && command -v supervisorctl >/dev/null || {
        echo 'This pod has no user systemd manager. Install supervisor (or rerun provision.sh) for persistent shared-browser services.' >&2
        exit 1
    }
fi
python3 -c 'import tomllib' || { echo 'Shared browser requires Python 3.11 or newer.' >&2; exit 1; }
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
browser_state=$("$node_path" "$runtime_dir/settings.mjs" stateDir)
if [ -f "$browser_state/supervisor.conf" ]; then
    # Preserve an existing backend if a user bus appears after installation.
    service_backend=supervisor
    command -v supervisord >/dev/null && command -v supervisorctl >/dev/null || {
        echo 'The existing browser uses Supervisor; reinstall the supervisor package and rerun.' >&2
        exit 1
    }
fi
browser_host_service=$("$node_path" "$runtime_dir/settings.mjs" hostService)
chrome_path=$("$node_path" "$runtime_dir/settings.mjs" chrome)
if [ -z "$chrome_path" ]; then chrome_path=$(command -v google-chrome || true); fi
if [ -z "$chrome_path" ] && [ -f "$HOME/.config/dev-tools/browser.json" ]; then
  chrome_path=$(python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/".config/dev-tools/browser.json").read_text()).get("chromium", ""))')
fi
if [ -z "$chrome_path" ]; then chrome_path=$(command -v google-chrome || command -v chromium); fi
browser_engine=${SHARED_BROWSER_ENGINE:-native}
case "$browser_engine" in
  native)
    xvfb_path=$(command -v Xvfb) || { echo 'Native Chrome requires Xvfb (Ubuntu: sudo apt-get install xvfb).' >&2; exit 1; }
    flock_path=$(command -v flock) || { echo 'Native Chrome requires flock from util-linux.' >&2; exit 1; }
    browser_dependency="Wants=$browser_host_service
After=$browser_host_service"
    ;;
  headless) browser_dependency='' ;;
  *) echo 'SHARED_BROWSER_ENGINE must be native or headless' >&2; exit 1 ;;
esac
npm ci
npm run build
if [ "$service_backend" = systemd ]; then
mkdir -p "$HOME/.config/systemd/user" "$browser_state"
chmod 700 "$browser_state"
browser_restore=false
if systemctl --user is-active --quiet dev-tools-shared-browser.service; then
  if [ "$browser_engine" = headless ] || ! systemctl --user is-active --quiet "$browser_host_service"; then
    "$node_path" "$runtime_dir/migrate-engine.mjs" save
    browser_restore=true
  fi
  # Stop an owned headless browser before starting the native host on its
  # profile. A native receiver update only disconnects; Chrome stays running.
  systemctl --user stop dev-tools-shared-browser.service
fi
# Retire the receiver's previous host before replacing its dependency. Keeping
# it alive can make copied authenticated tabs revoke the new browser's session.
if systemctl --user cat dev-tools-shared-browser.service >/dev/null 2>&1; then
    "$node_path" "$runtime_dir/host-migration.mjs" "$browser_host_service"
fi
if [ "$browser_engine" = headless ]; then
  systemctl --user disable --now "$browser_host_service" 2>/dev/null || true
fi
if [ "$browser_engine" = native ]; then
cat > "$HOME/.config/systemd/user/$browser_host_service" <<EOF
[Unit]
Description=Persistent native Chrome for the shared browser
After=network.target

[Service]
Type=simple
WorkingDirectory=$runtime_dir
ExecStart=$flock_path --no-fork "$browser_state/browser-host.lock" $node_path $runtime_dir/browser-host.mjs
Environment="SHARED_BROWSER_STATE=$browser_state"
Environment="SHARED_BROWSER_CHROME=$chrome_path"
Environment=SHARED_BROWSER_XVFB=$xvfb_path
UMask=0077
KillMode=mixed
TimeoutStopSec=20
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
fi
cat > "$HOME/.config/systemd/user/dev-tools-shared-browser.service" <<EOF
[Unit]
Description=Persistent DOM shared Chrome pilot
After=network.target
$browser_dependency

[Service]
Type=simple
WorkingDirectory=$runtime_dir
ExecStart=$node_path $runtime_dir/server.mjs
Environment="SHARED_BROWSER_STATE=$browser_state"
Environment="SHARED_BROWSER_CHROME=$chrome_path"
Environment=SHARED_BROWSER_ENGINE=$browser_engine
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
if [ "$browser_engine" = native ]; then
  systemctl --user enable --now "$browser_host_service"
fi
systemctl --user enable --now dev-tools-shared-browser.service
"$node_path" "$runtime_dir/rpc-alias.mjs"
if [ "$browser_restore" = true ]; then
  "$node_path" "$runtime_dir/migrate-engine.mjs" restore
fi
# The optional portal helper was originally installed in a separate runtime.
# Keep its Chrome discovery compatible when the shared engine is upgraded.
if systemctl --user is-active --quiet dev-tools-portal-passkey.service; then
  portal_runtime=$(systemctl --user show dev-tools-portal-passkey.service --property=WorkingDirectory --value)
  if [ ! -d "$portal_runtime" ]; then
    echo 'Active portal passkey helper has no valid runtime directory.' >&2
    exit 1
  fi
  if [ "$portal_runtime" != "$runtime_dir" ]; then
    install -m 0644 browser-endpoint.mjs settings.mjs portal-passkey-bridge.mjs portal-passkey-hook.js portal-passkey-origin.mjs "$portal_runtime/"
    mkdir -p "$portal_runtime/dist"
    install -m 0644 dist/portal-passkey.html dist/portal-passkey-client.js "$portal_runtime/dist/"
  fi
  systemctl --user restart dev-tools-portal-passkey.service
fi
else
    python3 "$runtime_dir/services.py" install "$browser_state" "$runtime_dir" "$node_path" "$chrome_path" "$browser_origin" "$browser_owner" "${xvfb_path:-}" "$browser_engine"
    "$node_path" "$runtime_dir/rpc-alias.mjs"
fi
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
if [ "$service_backend" = systemd ]; then
    systemctl --user disable --now dev-tools-native-browser-repair.path dev-tools-native-browser-repair.service 2>/dev/null || true
    python3 "$repo_dir/shared_browser/repair.py" --runtime "$runtime_dir" --node "$node_path"
else
    python3 "$repo_dir/shared_browser/repair.py" --once --runtime "$runtime_dir" --node "$node_path"
fi
"$node_path" "$runtime_dir/cli.mjs" start || {
    if [ "$service_backend" = supervisor ]; then
        echo "Shared browser did not become ready. Inspect $browser_state/chrome.log and $browser_state/receiver.log, then rerun." >&2
    else
        echo 'Shared browser did not become ready. Inspect journalctl --user -u dev-tools-shared-browser and the configured Chrome host service, then rerun.' >&2
    fi
    exit 1
}
echo "Installed and ready locally. Publish the dedicated Tailscale Serve port 8443 for viewer access."
