// Local visual QA only. Requires an SSH forward from 127.0.0.1:18793 to the
// pilot's loopback HTTP port. Never published; not a deployment alternative.
import http from "node:http";
const proxy = http.createServer((req, res) => {
  if(req.headers.host !== '127.0.0.1:18792' || req.headers['sec-fetch-site']==='cross-site'){
    res.writeHead(403);res.end('Local QA only');return;
  }
  const up = http.request(
    {
      host: "127.0.0.1",
      port: 18793,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, "tailscale-user-login": "manbir@asgroup.ai" },
    },
    (reply) => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    },
  );
  up.on("error", () => {
    res.writeHead(502);
    res.end("QA SSH forward unavailable");
  });
  req.pipe(up);
});
proxy.on("upgrade", (req, socket, head) => {
  if(req.headers.origin!=='http://127.0.0.1:18792'){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  const up = http.request({
    host: "127.0.0.1",
    port: 18793,
    path: req.url,
    headers: {
      ...req.headers,
      "tailscale-user-login": "manbir@asgroup.ai",
      origin: "https://procbox.agent-trace.ts.net:8443",
    },
  });
  up.on("upgrade", (res, remote, remoteHead) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        Object.entries(res.headers)
          .map(([k, v]) => k + ": " + v)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (head.length) remote.write(head);
    if (remoteHead.length) socket.write(remoteHead);
    socket.pipe(remote).pipe(socket);
    socket.on("error", () => remote.destroy());
    remote.on("error", () => socket.destroy());
  });
  up.on("error", () => socket.destroy());
  up.end();
});
proxy.listen(18792, "127.0.0.1", () =>
  console.log("Local QA only: http://127.0.0.1:18792"),
);
