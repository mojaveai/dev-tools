#!/bin/sh
# Shared helpers for the dev-tools provisioner. POSIX sh only.
# Sourced by provision.sh and every lib/*.sh module.
# shellcheck disable=SC2034  # these are consumed by the sourcing scripts

# --- exit codes modules return -----------------------------------------------
# 0  OK       already in the desired state, nothing to do
# 10 UPDATED  something was installed or changed
# 20 SKIP     not applicable here (missing prerequisite, wrong arch, no root)
# *  FAIL     anything else
RC_OK=0
RC_UPDATED=10
RC_SKIP=20

# --- output ------------------------------------------------------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
    C_RESET=$(printf '\033[0m'); C_DIM=$(printf '\033[2m')
    C_RED=$(printf '\033[31m');  C_GRN=$(printf '\033[32m')
    C_YEL=$(printf '\033[33m');  C_BLU=$(printf '\033[34m')
    C_BLD=$(printf '\033[1m')
else
    C_RESET=''; C_DIM=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BLD=''
fi

info() { printf '%s  %s\n'      "${C_BLU}::${C_RESET}" "$*"; }
warn() { printf '%s  %s\n'      "${C_YEL}!!${C_RESET}" "$*" >&2; }
err()  { printf '%s  %s\n'      "${C_RED}xx${C_RESET}" "$*" >&2; }
dbg()  { [ "${DEVTOOLS_DEBUG:-0}" = "1" ] && printf '%s  %s\n' "${C_DIM}..${C_RESET}" "$*" >&2 || true; }

# A module sets this to add a short parenthetical to its summary line.
STEP_NOTE=''
note() { STEP_NOTE="$*"; }

# --- environment probes ------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

is_root() { [ "$(id -u)" -eq 0 ]; }

# True when we can install system packages / bind privileged things.
can_privileged() {
    is_root && return 0
    have sudo || return 1
    # -n: never prompt. Confirms cached or passwordless sudo without hanging.
    sudo -n true >/dev/null 2>&1
}

run_privileged() {
    if is_root; then "$@"; return $?; fi
    if have sudo; then sudo "$@"; return $?; fi
    err "need privileges for: $*"
    return 1
}

has_systemd() { [ -d /run/systemd/system ]; }

# Normalised machine arch: x86_64 | aarch64 | other
arch() {
    case "$(uname -m)" in
        x86_64|amd64)  echo x86_64 ;;
        aarch64|arm64) echo aarch64 ;;
        *)             uname -m ;;
    esac
}

# Single-quote a value for safe embedding in a generated shell snippet.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# --- filesystem --------------------------------------------------------------
BIN_DIR="${DEVTOOLS_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${DEVTOOLS_STATE_DIR:-$HOME/.config/dev-tools}"

ensure_dirs() {
    mkdir -p "$BIN_DIR"
    mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
}

# download URL DEST -- curl with retries, fails loudly, never leaves a partial file
download() {
    _url=$1; _dest=$2
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 -o "$_dest.part" "$_url" || {
        rm -f "$_dest.part"; return 1; }
    mv -f "$_dest.part" "$_dest"
}

# Replace a marked block in a file, creating the file if absent.
# Content is read from stdin. Removals propagate because the whole block is
# rewritten rather than appended to.
#   managed_block FILE NAME < content
managed_block() {
    _file=$1; _name=$2
    _begin="# BEGIN dev-tools:$_name"
    _end="# END dev-tools:$_name"
    _body=$(cat)

    [ -f "$_file" ] || { : > "$_file"; }

    _tmp=$(mktemp "${TMPDIR:-/tmp}/devtools.XXXXXX") || return 1
    # Copy everything outside the block, then append the fresh block.
    awk -v b="$_begin" -v e="$_end" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        !skip   { print }
    ' "$_file" > "$_tmp" || { rm -f "$_tmp"; return 1; }

    # Drop trailing blank lines so repeated runs do not accumulate them.
    while [ -s "$_tmp" ] && [ -z "$(tail -n 1 "$_tmp")" ]; do
        sed -i '$ d' "$_tmp" 2>/dev/null || break
    done

    {
        [ -s "$_tmp" ] && echo ''
        echo "$_begin"
        echo "$_body"
        echo "$_end"
    } >> "$_tmp"

    # Preserve the original mode; default to 0600 for new files.
    if [ -f "$_file" ]; then
        _mode=$(stat -c '%a' "$_file" 2>/dev/null || echo 600)
    else
        _mode=600
    fi
    cat "$_tmp" > "$_file"
    chmod "$_mode" "$_file"
    rm -f "$_tmp"
}

# Did the managed block change? Compare before/after to decide OK vs UPDATED.
file_digest() { [ -f "$1" ] && cksum < "$1" || echo absent; }

# Run an installer quietly, but show why it failed rather than swallowing it.
# A bare "install failed" on a fresh box is close to undebuggable.
#   run_installer <interpreter> <script> [args...]
run_installer() {
    _interp=$1; _script=$2; shift 2
    _ilog=$(mktemp "${TMPDIR:-/tmp}/devtools-install.XXXXXX") || return 1
    if "$_interp" "$_script" "$@" >"$_ilog" 2>&1; then
        rm -f "$_ilog"; return 0
    fi
    err "installer failed ($_interp $(basename "$_script")):"
    sed -e 's/\x1b\[[0-9;]*m//g' "$_ilog" | tail -8 | sed 's/^/      /' >&2
    rm -f "$_ilog"
    return 1
}

# --- config merging ----------------------------------------------------------
# Merge our keys into a user-owned config without clobbering their other keys.
# Both helpers are no-ops that report success when nothing changed.

json_merge() {  # json_merge TARGET  < patch.json
    _target=$1
    DEVTOOLS_PATCH=$(cat) python3 - "$_target" <<'PY'
import json, sys, os
target = sys.argv[1]
patch = json.loads(os.environ['DEVTOOLS_PATCH'])
try:
    with open(target) as fh:
        cur = json.load(fh)
except (FileNotFoundError, json.JSONDecodeError):
    cur = {}
def deep(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep(dst[k], v)
        else:
            dst[k] = v
before = json.dumps(cur, sort_keys=True)
deep(cur, patch)
after = json.dumps(cur, sort_keys=True)
if before != after:
    os.makedirs(os.path.dirname(target) or '.', exist_ok=True)
    tmp = target + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(cur, fh, indent=2)
        fh.write('\n')
    os.replace(tmp, target)
    os.chmod(target, 0o600)
    sys.exit(10)
sys.exit(0)
PY
}

toml_merge() {  # toml_merge TARGET  < patch.toml
    _target=$1
    DEVTOOLS_PATCH=$(cat) python3 - "$_target" <<'PY'
import os, sys, re
target = sys.argv[1]
patch_text = os.environ['DEVTOOLS_PATCH']

try:
    import tomllib
except ModuleNotFoundError:
    sys.stderr.write('python3 >= 3.11 with tomllib is required to merge TOML\n')
    sys.exit(1)

patch = tomllib.loads(patch_text)
try:
    with open(target, 'rb') as fh:
        cur = tomllib.load(fh)
except FileNotFoundError:
    cur = {}
except tomllib.TOMLDecodeError as exc:
    sys.stderr.write('existing TOML is malformed, refusing to touch it: %s\n' % exc)
    sys.exit(1)

def deep(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep(dst[k], v)
        else:
            dst[k] = v

def same(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        return all(k in a and same(a[k], v) for k, v in b.items())
    return a == b

if same(cur, patch):
    sys.exit(0)

# Rewrite only the tables we own, textually, so comments and key order in the
# rest of the user's file survive. Codex rewrites this file from a template;
# clobbering it wholesale would lose their settings.
def dumps(v):
    if isinstance(v, bool):   return 'true' if v else 'false'
    if isinstance(v, (int, float)): return repr(v)
    if isinstance(v, str):    return '"%s"' % v.replace('\\', '\\\\').replace('"', '\\"')
    if isinstance(v, list):   return '[' + ', '.join(dumps(x) for x in v) + ']'
    raise TypeError(v)

try:
    with open(target) as fh:
        text = fh.read()
except FileNotFoundError:
    text = ''

def set_scalar(text, key, value):
    pat = re.compile(r'(?m)^\s*%s\s*=.*$' % re.escape(key))
    line = '%s = %s' % (key, dumps(value))
    if pat.search(text):
        return pat.sub(line, text, count=1)
    # Insert after any leading comment header, before the first table.
    lines = text.split('\n')
    i = 0
    while i < len(lines) and (lines[i].startswith('#') or not lines[i].strip()):
        i += 1
    lines.insert(i, line)
    return '\n'.join(lines)

def set_table(text, name, mapping):
    header = '[%s]' % name
    body = '\n'.join('%s = %s' % (k, dumps(v)) for k, v in mapping.items())
    block = header + '\n' + body + '\n'
    pat = re.compile(r'(?ms)^\[%s\]\s*\n(?:(?!^\[).*\n?)*' % re.escape(name))
    if pat.search(text):
        return pat.sub(block, text, count=1)
    return text.rstrip('\n') + '\n\n' + block

def walk(prefix, mapping, text):
    scalars = {k: v for k, v in mapping.items() if not isinstance(v, dict)}
    if scalars:
        if prefix:
            text = set_table(text, prefix, scalars)
        else:
            for k, v in scalars.items():
                text = set_scalar(text, k, v)
    for k, v in mapping.items():
        if isinstance(v, dict):
            text = walk('%s.%s' % (prefix, k) if prefix else k, v, text)
    return text

text = walk('', patch, text)
os.makedirs(os.path.dirname(target) or '.', exist_ok=True)
tmp = target + '.tmp'
with open(tmp, 'w') as fh:
    fh.write(text if text.endswith('\n') else text + '\n')
os.replace(tmp, target)
os.chmod(target, 0o600)
sys.exit(10)
PY
}
