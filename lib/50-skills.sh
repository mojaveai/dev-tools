#!/bin/sh
# Link skills/ from this repo into both agent CLIs.

SKILL_SRC="$REPO_DIR/skills"

link_skills_into() {
    _dest=$1
    [ -d "$_dest" ] || mkdir -p "$_dest" || return 1
    _changed=0

    for _s in "$SKILL_SRC"/*/; do
        [ -d "$_s" ] || continue
        _name=$(basename "$_s")
        _target="$_dest/$_name"
        _want=${_s%/}
        if [ -L "$_target" ] && [ "$(readlink "$_target")" = "$_want" ]; then
            continue
        fi
        if [ -e "$_target" ] && [ ! -L "$_target" ]; then
            # Never clobber a real directory the user put there by hand.
            warn "$_target exists and is not a symlink; leaving it alone"
            continue
        fi
        ln -sfn "$_want" "$_target" || return 1
        _changed=1
    done

    # Prune symlinks we own that point at skills no longer in the repo, so
    # removals converge instead of lingering forever.
    for _l in "$_dest"/*; do
        [ -L "$_l" ] || continue
        _t=$(readlink "$_l")
        case "$_t" in
            "$SKILL_SRC"/*)
                [ -d "$_t" ] || { rm -f "$_l"; _changed=1; } ;;
        esac
    done

    echo "$_changed"
}

mod_skills() {
    [ -d "$SKILL_SRC" ] || { note "no skills/ in repo"; return "$RC_SKIP"; }
    _n=$(find "$SKILL_SRC" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    [ "$_n" -gt 0 ] || { note "skills/ empty"; return "$RC_SKIP"; }

    # Symlinks outlive this process, so the source has to be a stable path.
    case "$SKILL_SRC" in
        "$HOME"/*) : ;;
        /tmp/*|/var/tmp/*)
            warn "skills would be linked from a temporary path ($SKILL_SRC);"
            warn "  run via bootstrap.sh so they are installed under ~/.local/share/dev-tools"
            ;;
    esac

    _c1=$(link_skills_into "$HOME/.claude/skills") || { err "linking into ~/.claude/skills failed"; return 1; }
    _c2=$(link_skills_into "$HOME/.codex/skills")  || { err "linking into ~/.codex/skills failed"; return 1; }

    note "$_n skill(s) linked into claude + codex"
    [ "$_c1" = "1" ] || [ "$_c2" = "1" ] && return "$RC_UPDATED"
    return "$RC_OK"
}
