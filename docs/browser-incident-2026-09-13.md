# Procbox browser outage, September 13, 2026

The agent's discovery and post-reset checks around 19:59–20:01 EDT returned
`relay_socket_missing`. At 20:06 EDT the stable path
`~/.codex/run/mac-native-browser.sock` was absent, while its owner marker,
`nb-46a7a267b8334d6e.sock` listener, and remote heartbeat process remained.
The Mac supervisor last logged that generation connecting at 23:45:10 EDT
on September 12. Its SSH connection had not failed again.

Restoring only the symlink to that existing generation immediately produced
`route: mac`, `ready: true`, `reason: browser_connected`. No desktop app,
browser, relay, or Codex restart was needed. Thus the immediate cause was a
missing published endpoint, and the prolonged outage was caused by checking
SSH heartbeats without checking continued publication of the endpoint.

The run directory's modification time before repair was 18:11 EDT, preceding
this diagnostic Mac session (20:03 EDT). Directory mtime does not prove the
exact deletion time. Available logs do not identify the deleting process;
there is no evidence establishing that starting a Mac Codex session deleted it.
No filesystem audit trail was available to attribute the unlink retrospectively.
Earlier runtime initialization errors are not established as the cause of this
incident; empty socket probes can also produce such errors.

The watchdog now checks the generation and published path before every heartbeat
acknowledgement. It recreates missing symlinks, records repairs, and fails a lost
generation so supervision reconnects. It preserves conflicting paths and owner
changes. With a healthy connection, repair normally occurs within the existing
two-second heartbeat interval. Network stalls retain the upstream 60/75-second
deadlines and two-second reconnect backoff. Sleep, unavailable SSH, app shutdown,
and authentication requirements still limit availability. Interrupted browser
actions are never automatically replayed.
