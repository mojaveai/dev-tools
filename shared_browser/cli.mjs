import { rpc } from "./rpc.mjs";
import { startServices } from "./services.mjs";
const command = process.argv[2] || "status";
try {
  if (command === "start") {
    await startServices();
    let ready;
    for (let n = 0; n < 30; n++) {
      try {
        ready = await rpc("state");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!ready)
      throw Error(
        "Session not ready; inspect receiver.log/chrome.log in the browser state directory, or journalctl --user -u dev-tools-shared-browser on systemd hosts",
      );
    console.log(JSON.stringify(ready, null, 2));
  } else if (command === "status" || command === "url") {
    const s = await rpc("state");
    console.log(command === "url" ? s.viewerUrl : JSON.stringify(s, null, 2));
  } else if (command === "stop") console.log(JSON.stringify(await rpc("stop")));
  else if (command === "request-input") {
    console.log(
      JSON.stringify(
        await rpc("js", {
          context: "cli",
          code: `await cua.requestHumanInput(${JSON.stringify(process.argv[3] || "Please take control.")})`,
        }),
        null,
        2,
      ),
    );
  } else
    throw Error(
      "Usage: dev-tools shared-browser {start|status|url|request-input|stop|mcp}",
    );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
