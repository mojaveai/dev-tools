#!/bin/sh
# Values are resolved only in a short-lived child, never in shell configuration.
. "$REPO_DIR/lib/common.sh"
. "$REPO_DIR/lib/25-passcli.sh"
case "$1" in verify|email|password|totp) : ;; *) exit 1 ;; esac
[ "${DEVTOOLS_PASS_READY:-0}" = 1 ] || exit 1
_login_refs_dir=${DEVTOOLS_CODEX_LOGIN_REFS_DIR:-$REPO_DIR/config/codex}
_login_refs="$_login_refs_dir/login-$1.refs"
if [ "$1" = verify ]; then
    _login_refs=$(mktemp "${TMPDIR:-/tmp}/devtools-login-refs.XXXXXX") || exit 1
    chmod 600 "$_login_refs"
    trap 'rm -f "$_login_refs"' EXIT
    cat "${DEVTOOLS_CODEX_IDENTITY_REFS:-$REPO_DIR/config/codex/identity.refs}" "$_login_refs_dir/login-email.refs" > "$_login_refs" || exit 1
fi
printf 'pass-cli run --env-file %s -- %s %s %s\n' \
    "$(quote "$_login_refs")" \
    "$(quote "$(command -v node)")" "$(quote "$REPO_DIR/auth/login-step.cjs")" "$(quote "$1")" | pass_session_run
