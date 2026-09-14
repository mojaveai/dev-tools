import http from "node:http";
import path from "node:path";
import os from "node:os";
export function rpc(method, data = {}) {
  const socketPath = path.join(
    process.env.SHARED_BROWSER_STATE ||
      path.join(os.homedir(), ".local/state/dev-tools/shared-browser"),
    "server.sock",
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/" + method,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const value = JSON.parse(data);
            if (res.statusCode >= 400) reject(Error(value.error));
            else resolve(value);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(70000, () =>
      req.destroy(Error("RPC timed out; inspect state before retrying")),
    );
    req.end(JSON.stringify(data));
  });
}
