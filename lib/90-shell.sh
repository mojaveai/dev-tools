#!/bin/sh
# Shell environment: PATH and the secret-bearing env file, both idempotent.

mod_shell() {
    _rc="$RC_OK"
    ensure_dirs
    _envf="$STATE_DIR/env.sh"

    # Secrets go in a 0600 file rather than into .bashrc or settings.json, so
    # neither the shell profile nor any tracked config carries a credential.
    _d0=$(file_digest "$_envf")
    umask 077
    {
        echo "# Written by dev-tools. Do not edit; re-run the provisioner instead."
        secret_have CLAUDE_CODE_OAUTH_TOKEN && \
            echo "export CLAUDE_CODE_OAUTH_TOKEN=$(quote "$CLAUDE_CODE_OAUTH_TOKEN")"
        secret_have GH_TOKEN && \
            echo "export GH_TOKEN=$(quote "$GH_TOKEN")"
        secret_have ELEVENLABS_API_KEY && \
            echo "export ELEVENLABS_API_KEY=$(quote "$ELEVENLABS_API_KEY")"
        secret_have OPENROUTER_API_KEY && \
            echo "export OPENROUTER_API_KEY=$(quote "$OPENROUTER_API_KEY")"
        echo "export PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE=$(quote "$STATE_DIR/proton-pass.pat")"
    } > "$_envf"
    chmod 600 "$_envf"
    [ "$(file_digest "$_envf")" = "$_d0" ] || _rc="$RC_UPDATED"

    _bashrc="$HOME/.bashrc"
    _d1=$(file_digest "$_bashrc")
    managed_block "$_bashrc" "shell" <<BLOCK
case ":\$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) PATH="$BIN_DIR:\$PATH"; export PATH ;;
esac
[ -r "$_envf" ] && . "$_envf"
BLOCK
    [ "$(file_digest "$_bashrc")" = "$_d1" ] || _rc="$RC_UPDATED"

    # Some login shells read only .bash_profile, which then must pull in .bashrc.
    if [ ! -f "$HOME/.bash_profile" ] && [ ! -f "$HOME/.profile" ]; then
        printf '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n' > "$HOME/.bash_profile"
        _rc="$RC_UPDATED"
    fi

    note "PATH + env file"
    return "$_rc"
}
