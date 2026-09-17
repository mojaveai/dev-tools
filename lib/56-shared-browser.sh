#!/bin/sh
# Default Linux browser: install the actual shared runtime and verify readiness.
shared_browser_install() (
    # Isolate helper variables from the provisioner's step runner.
    [ "$(uname -s)" = Linux ] || return "$RC_SKIP"
    . /etc/os-release
    case "$ID" in ubuntu|debian) : ;; *) echo "Shared browser currently requires Ubuntu or Debian" >&2; return 1 ;; esac
    missing=''
    for package in xvfb xauth util-linux xz-utils; do
        dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$' || missing="$missing $package"
    done
    if ! systemctl --user show-environment >/dev/null 2>&1; then
        have supervisord && have supervisorctl || missing="$missing supervisor"
    fi
    if [ -n "$missing" ]; then
        can_privileged || { echo "Shared browser needs packages:$missing (sudo required)" >&2; return 1; }
        pkg_refresh_once
        run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y $missing || return 1
    fi
    browser_node=${SHARED_BROWSER_NODE:-$(command -v node || true)}
    if [ -z "$browser_node" ] || ! "$browser_node" -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
        # Node supplied by older distro releases cannot run this runtime. Use a
        # private, checksum-verified LTS build without replacing system Node.
        case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64) node_arch=arm64 ;; *) return 1 ;; esac
        node_root="$HOME/.local/share/dev-tools-node"
        mkdir -p "$node_root" || return 1
        node_temp=$(mktemp -d) || return 1
        trap 'rm -rf "$node_temp"' EXIT
        download https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt "$node_temp/sums" || return 1
        node_file=$(awk -v suffix="-linux-$node_arch.tar.xz" 'substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$node_temp/sums")
        [ -n "$node_file" ] || return 1
        download "https://nodejs.org/dist/latest-v24.x/$node_file" "$node_temp/$node_file" || return 1
        (cd "$node_temp" && awk -v file="$node_file" '$2==file' sums | sha256sum -c -) || return 1
        tar -xJf "$node_temp/$node_file" -C "$node_root" || return 1
        browser_node="$node_root/${node_file%.tar.xz}/bin/node"
    fi
    PATH="$(dirname "$browser_node"):$PATH"; export PATH
    have npm || { echo 'Shared browser requires npm alongside Node' >&2; return 1; }
    chrome=$("$browser_node" "$REPO_DIR/shared_browser/settings.mjs" chrome) || return 1
    [ -n "$chrome" ] || chrome=$(command -v google-chrome || true)
    if [ -z "$chrome" ] && [ -f "$HOME/.config/dev-tools/browser.json" ]; then
        chrome=$(python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/".config/dev-tools/browser.json").read_text()).get("chromium", ""))') || return 1
    fi
    if [ -z "$chrome" ] || [ ! -x "$chrome" ]; then
        chrome_runtime="$HOME/.local/share/dev-tools-browser/runtime"
        mkdir -p "$chrome_runtime" || return 1
        cp "$REPO_DIR/config/browser/package.json" "$REPO_DIR/config/browser/package-lock.json" "$chrome_runtime/" || return 1
        (cd "$chrome_runtime" && npm ci --no-audit --no-fund && node node_modules/playwright/cli.js install chromium) || return 1
        chrome=$(cd "$chrome_runtime" && node -e 'process.stdout.write(require("playwright").chromium.executablePath())') || return 1
    fi
    if ldd "$chrome" 2>/dev/null | grep -q 'not found'; then
        can_privileged || { echo 'Chromium system dependencies require sudo' >&2; return 1; }
        # Use the pinned Playwright dependency installer for Linux libraries.
        chrome_runtime="$HOME/.local/share/dev-tools-browser/runtime"
        mkdir -p "$chrome_runtime" || return 1
        cp "$REPO_DIR/config/browser/package.json" "$REPO_DIR/config/browser/package-lock.json" "$chrome_runtime/" || return 1
        (cd "$chrome_runtime" && npm ci --no-audit --no-fund) || return 1
        run_privileged "$browser_node" "$chrome_runtime/node_modules/playwright/cli.js" install-deps chromium || return 1
    fi
    python3 "$REPO_DIR/browser/sandbox.py" repair "$chrome"
    case $? in 0|10) : ;; *) return 1 ;; esac
    browser_serve_operator || return 1
    runtime="$HOME/.local/share/dev-tools-shared-browser"
    python3 - "$REPO_DIR/shared_browser" "$runtime" <<'PY'
import shutil,sys
shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True,
                ignore=shutil.ignore_patterns('node_modules','dist','test','safari-auth','__pycache__'))
PY
    [ $? = 0 ] || return 1
    ensure_dirs || return 1
    if [ -e "$BIN_DIR/dev-tools" ] && [ ! -L "$BIN_DIR/dev-tools" ]; then
        echo 'Refusing to overwrite unmanaged dev-tools executable' >&2; return 1
    fi
    ln -sfn "$REPO_DIR/bin/dev-tools" "$BIN_DIR/dev-tools" || return 1
    SHARED_BROWSER_NODE="$browser_node" SHARED_BROWSER_CHROME="$chrome" SHARED_BROWSER_REPO="$REPO_DIR" sh "$runtime/install.sh" || return 1
    python3 "$REPO_DIR/shared_browser/publish.py" || return 1
    # Containers lack boot-time user units. Start on shell entry as well as
    # first MCP use; Supervisor keeps services alive after SSH disconnects.
    if ! systemctl --user show-environment >/dev/null 2>&1; then
        browser_state=$("$browser_node" "$runtime/settings.mjs" stateDir) || return 1
        managed_block "$HOME/.bashrc" shared-browser <<BLOCK
python3 $(quote "$runtime/services.py") start $(quote "$browser_state") >/dev/null 2>&1 &
BLOCK
    fi
    return 0
)

mod_shared_browser() {
    shared_browser_install
    _shared_result=$?
    if [ "$_shared_result" = 0 ]; then
        note "shared_browser_repl ready; private viewer published; reconnect MCP to load"
    else
        note "shared browser setup incomplete; see diagnostic above and rerun"
    fi
    return "$_shared_result"
}
