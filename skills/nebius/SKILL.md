---
name: nebius
description: Use the Nebius CLI (nebius) on dev-tools hosts, including re-authenticating its federation login through the shared browser when a command asks you to open a sign-in link.
---

The `nebius` CLI lives at `~/.nebius/bin/nebius` and uses the federation
profile in `~/.nebius/config.yaml`. On Linux hosts always pass `--no-browser`;
there is no desktop browser to open automatically. On a Mac, run it normally.

When a command fails with an expired token or prints "open the following link
in your browser", run:

```sh
sh ~/.claude/skills/nebius/scripts/login.sh
```

It opens the authorize link in this host's shared browser, whose loopback
redirect reaches the CLI's `127.0.0.1` listener. The shared browser normally
stays signed in to auth.nebius.com, so this completes without input. If a
sign-in is needed, the script asks through the viewer and prints the viewer URL
to share with the user. Never ask for Nebius passwords or codes in chat.

Do not paste the authorize link to the user to open on their own machine: the
callback only works from this host. Check the result with
`nebius iam whoami --no-browser`.

If console.nebius.com shows Cloudflare's "Sorry, you have been blocked", the
shared browser holds a stale clearance cookie. Clearance cookies are purged
whenever Chrome itself starts (`dev-tools shared-browser stop` only stops the
receiver), so tell the user and, with their OK, restart the browser host:
`systemctl --user restart dev-tools-shared-chrome` on systemd hosts, or
`supervisorctl -c ~/.local/state/dev-tools/shared-browser/supervisor.conf restart chrome receiver`
in Coder pods. Restarting closes open tabs. Do not clear the whole profile.
