import http from "node:http";
import path from "node:path";
import {browserSettings} from './settings.mjs';
import {ensureServices} from './services.mjs';
export async function rpc(method, data = {}) {
  await ensureServices();
  const socketPath = path.join((await browserSettings()).stateDir,"server.sock");
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
