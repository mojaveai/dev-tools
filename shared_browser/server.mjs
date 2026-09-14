import http from "node:http";
import { AssetDelivery, rewriteStylesheet } from "./asset-delivery.mjs";
import { compactImages } from "./compact-images.mjs";
import { createSocketDelivery } from "./socket-delivery.mjs";
import { createReadStream } from "node:fs";
import { UploadStore, remoteFiles, validateSizes, MAX_BATCH_BYTES } from "./transfers.mjs";
import { Downloads } from "./downloads.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { WebSocketServer } from "ws";
import { ActionFeedback } from "./feedback.mjs";
import { AgentRuntime } from "./runtime.mjs";
import { RemoteMouse } from "./remote-mouse.mjs";
import { loopbackEndpoint } from "./browser-host.mjs";
import { resourceRecovery } from "./resource-recovery.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const stateDir =
  process.env.SHARED_BROWSER_STATE ||
  path.join(os.homedir(), ".local/state/dev-tools/shared-browser");
const port = Number(process.env.SHARED_BROWSER_PORT || 8791);
const publicOrigin =
  process.env.SHARED_BROWSER_ORIGIN ||
  "https://procbox.agent-trace.ts.net:8443";
const owner = process.env.SHARED_BROWSER_OWNER || "manbir@asgroup.ai";
const executablePath =
  process.env.SHARED_BROWSER_CHROME || "/usr/bin/google-chrome";
await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
const recorder = await fs.readFile(path.join(root, "dist/recorder.js"), "utf8");
// Diagnostic attachment keeps the desktop supervisor responsible for Chrome.
const externalBrowserURL=process.env.SHARED_BROWSER_CDP_URL;
const nativeEngine=process.env.SHARED_BROWSER_ENGINE==='native';
let managedEndpoint;
if(nativeEngine && !externalBrowserURL){
  for(let i=0;i<150;i++){
    try {
      const host=JSON.parse(await fs.readFile(path.join(stateDir,'browser-host.json'),'utf8'));
      managedEndpoint=loopbackEndpoint(host.browserWSEndpoint);break;
    }catch(error){if(i===149)throw Error('Native Chrome is not ready; check dev-tools-shared-chrome.service: '+error.message);}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
}
if(externalBrowserURL){
  const u=new URL(externalBrowserURL);
  if(u.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password)
    throw Error('External browser attachment must use an uncredentialed loopback HTTP endpoint');
}
const browser = managedEndpoint
  ? await puppeteer.connect({browserWSEndpoint:managedEndpoint,defaultViewport:null})
  : externalBrowserURL
  ? await puppeteer.connect({browserURL:externalBrowserURL,defaultViewport:null})
  : await puppeteer.launch({
  executablePath,
  headless: process.env.SHARED_BROWSER_HEADLESS !== 'false',
  userDataDir: path.join(stateDir, "profile"),
  defaultViewport: { width: 1280, height: 800 },
  args: [
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});
const transferDir = await fs.mkdtemp(path.join(stateDir, 'transfers-'));
const uploads = new UploadStore(path.join(transferDir, 'uploads'));
const downloads = new Downloads(path.join(transferDir, 'downloads'), () => {
  session.update().catch(() => {});
});
const sockets = new Set();
const remoteMouse=new RemoteMouse();
let activeUploads = 0;
let queue = Promise.resolve();
let running = true;
const serial = (fn) => {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
};
const json = (res, data, status = 200) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
};
const deliver=createSocketDelivery();
const send = (ws, data) => {
  if (ws.readyState === 1) {
    const raw = JSON.stringify(data);
    session.bytesSent += Buffer.byteLength(raw);
    deliver(ws,raw);
  }
};
const broadcast = (data) => {
  for (const ws of sockets) send(ws, data);
};
const actionFeedback=new ActionFeedback({send:broadcast,hasViewers:()=>sockets.size>0});
const session = {
  id: "pilot",
  tabs: new Map(),
  active: null,
  controller: "shared",
  message: "",
  bytesSent: 0,
  async tabList() {
    return Promise.all(
      [...this.tabs.values()].map(async (t) => ({
        id: t.id,
        url: t.page.url(),
        title: await t.page.title().catch(() => ""),
        generation: t.generation,
      })),
    );
  },
  async state() {
    return {
      sessionId: this.id,
      engine: managedEndpoint ? 'native' : externalBrowserURL ? 'attached' : process.env.SHARED_BROWSER_HEADLESS==='false' ? 'headed-automation' : 'headless',
      viewerUrl: publicOrigin + "/",
      controller: this.controller,
      message: this.message,
      tabs: await this.tabList(),
      activeTab: this.active,
      viewers: sockets.size,
      bytesSent: this.bytesSent,
      downloads: downloads.list(),
      choosers: [...this.tabs.values()].filter(t => t.chooser).map(t => ({tab:t.id, generation:t.generation, ...t.chooser.public})),
    };
  },
  async update() {
    broadcast({ type: "state", ...(await this.state()) });
  },
  async feedback(tab,element,kind,action) {
    let target={};
    if (sockets.size && element) {
      await element.scrollIntoView();
      target=await element.evaluate(e=>{
        const r=e.getBoundingClientRect();
        return {node:window.__sharedMirror?.getId(e),x:r.left+r.width/2,y:r.top+r.height/2,
          rect:{x:r.left,y:r.top,width:r.width,height:r.height}};
      });
    }
    return actionFeedback.run({tab:tab.id,generation:tab.generation,kind,...target},action);
  },
  async feedbackPoint(tab,point,kind,action) {
    return actionFeedback.run({tab:tab.id,generation:tab.generation,kind,...point},action);
  },
  agentAction(fn) {
    return serial(async () => {
      return fn();
    });
  },
  async handoff(message) {
    return serial(async () => {
      this.controller = "shared";
      this.message = String(
        message || "Please interact with the page when ready.",
      );
      await this.update();
      return this.state();
    });
  },
  async navigate(tab, url) {
    const u = new URL(url);
    if (!["http:", "https:", "about:"].includes(u.protocol))
      throw Error("Only web pages are supported");
    this.active = tab.id;
    await tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.update();
    return { id: tab.id, url: tab.page.url() };
  },
  async newTab(url) {
    const page = await browser.newPage();
    const tab = await attach(page);
    this.active = tab.id;
    if (url) await this.navigate(tab, url);
    await this.update();
    return tab;
  },
  async snapshot(tab) {
    return tab.page.evaluate(() => ({
      title: document.title,
      text: document.body?.innerText.slice(0, 22000),
      elements: [
        ...document.querySelectorAll("input,textarea,select,button,a,[role]"),
      ]
        .filter((e) => e.getClientRects().length)
        .slice(0, 150)
        .map((e) => ({
          node: window.__sharedMirror?.getId(e),
          tag: e.tagName,
          id: e.id,
          role: e.getAttribute("role"),
          label:
            e.getAttribute("aria-label") ||
            [...(e.labels || [])].map((l) => l.innerText).join(" "),
          text: e.innerText?.slice(0, 180),
          value: e.type === "password" ? "[masked]" : e.value,
          checked: e.checked,
        })),
    }));
  },
  downloads(agent = false) { return downloads.list(agent); },
  async setFiles(tab, element, paths) {
    const files = await remoteFiles(paths);
    const props = await element.evaluate(e => ({file:e.tagName === 'INPUT' && e.type === 'file', multiple:e.multiple, disabled:e.disabled, directory:e.webkitdirectory}));
    if (!props.file || props.disabled || props.directory) throw Error('Choose an enabled file input; folders are not supported');
    validateSizes(files, props.multiple);
    const visible = await element.isVisible();
    await this.feedback(tab, visible ? element : null, 'upload', async () => {
      await element.uploadFile(...files.map(f => f.path));
      await element.evaluate(e => e.setAttribute('data-shared-file-names', [...e.files].map(f=>f.name).join(', ')));
    });
    tab.chooser = null;
    await this.update();
    return files.map(({name, size}) => ({name,size}));
  },
  async chooseFiles(tab, paths) {
    const chooser = tab.chooser;
    if (!chooser || chooser.generation !== tab.generation) throw Error('File chooser is no longer open');
    const files = await remoteFiles(paths);
    validateSizes(files, chooser.public.multiple);
    await tab.cdp.send('DOM.setFileInputFiles', {backendNodeId:chooser.backendNodeId, files:files.map(f=>f.path)});
    tab.chooser = null;
    await this.update();
    return files.map(({name,size})=>({name,size}));
  },
  async handleDialog(tab, { accept, text }) {
    if (!tab.dialog) throw Error("No pending dialog");
    const d = tab.dialog;
    tab.dialog = null;
    if (accept) await d.accept(text);
    else await d.dismiss();
    await this.update();
  },
};
const attachments = new WeakMap();
function attach(page) {
  if (attachments.has(page)) return attachments.get(page);
  const promise = attachPage(page);
  attachments.set(page, promise);
  return promise;
}
async function attachPage(page) {
  const tab = {
    id: randomUUID().slice(0, 8),
    page,
    generation: null,
    events: [],
    eventBytes: 0,
    dialog: null,
    resources: new Map(),
    resourceBytes: 0,
  };
  session.tabs.set(tab.id, tab);
  tab.cdp = await page.createCDPSession();
  await tab.cdp.send('Page.enable');
  const remember=(url,resource)=>{
    if(resource.bytes.length>8*1024*1024)return;
    const old=tab.resources.get(url);
    if(old){tab.resourceBytes-=old.bytes.length;tab.resources.delete(url);}
    while(tab.resources.size && (tab.resources.size>=300 || tab.resourceBytes+resource.bytes.length>64*1024*1024)){
      const key=tab.resources.keys().next().value;
      tab.resourceBytes-=tab.resources.get(key).bytes.length;tab.resources.delete(key);
    }
    tab.resourceBytes+=resource.bytes.length;tab.resources.set(url,resource);
    tab.assetDelivery?.available(url);
  };
  // Begin listening before recovery/recorder setup so a loading popup cannot
  // finish its assets in the gap between those asynchronous operations.
  page.on("response", async (response) => {
    const type = response.request().resourceType();
    // A revalidated resource has status 304, but Chrome still supplies the
    // cached body. response.ok() alone silently drops these images/fonts.
    if (!["image", "font", "stylesheet"].includes(type) || (!response.ok() && response.status() !== 304))
      return;
    try {
      const bytes = await response.buffer();
      const contentType = response.headers()["content-type"];
      // 304 headers may omit the original MIME type. Chrome's resource tree
      // retains it; serving SVG bytes as octet-stream breaks Safari decoding.
      if (!contentType && response.status() === 304) {
        await tab.recoverResource?.(response.url());
        return;
      }
      remember(response.url(), {
        bytes,
        type: contentType || "application/octet-stream",
      });
    } catch {
      await tab.recoverResource?.(response.url()).catch(() => {});
    }
  });
  // Out-of-process frames have their own resource store. Frame.client is the
  // pinned Puppeteer API for that frame's already-enabled protocol session.
  const resourceClients=()=>[...new Set(page.frames().map(frame=>frame.client))];
  tab.recoverResource=await resourceRecovery(resourceClients,(url,resource)=>{
    if(!tab.resources.has(url))remember(url,resource);
  });
  tab.assetDelivery=new AssetDelivery(tab.resources,{recover:tab.recoverResource});
  await tab.cdp.send('Page.setInterceptFileChooserDialog', {enabled:true});
  tab.cdp.on('Page.fileChooserOpened', event => {
    if (!event.backendNodeId) return;
    tab.chooser = {backendNodeId:event.backendNodeId, generation:tab.generation,
      public:{id:randomUUID(), multiple:event.mode === 'selectMultiple'}};
    session.update().catch(() => {});
  });
  if (!session.active) session.active = tab.id;
  await page.exposeFunction("__sharedEmit", ({ generation, event }) => {
    // Cross-origin child recording is relayed by rrweb to the top-level recorder.
    if (event.type === 2) {
      tab.events = tab.events.filter((e) => e.event.type === 4).slice(-1);
      tab.eventBytes = 0;
      tab.generation = generation;
    }
    if (!tab.generation) tab.generation = generation;
    if (generation !== tab.generation && event.type !== 4) return;
    compactImages(event,tab.resources);
    const item = { type: "event", tab: tab.id, generation, event };
    tab.events.push(item);
    tab.eventBytes += JSON.stringify(item).length;
    if (tab.eventBytes > 12 * 1024 * 1024) {
      tab.events = [];
      tab.eventBytes = 0;
      page.evaluate(() => window.__sharedSnapshot?.()).catch(() => {});
    }
    broadcast(item);
  });
  await page.evaluateOnNewDocument(recorder);
  // Preserve the existing document's recorder and mirror when reconnecting.
  // Re-evaluating rrweb creates another iframe message mapper; stopping record
  // does not remove that mapper in 2.1.4. New documents receive the new bundle.
  const recorded=await page.evaluate(()=>!!(window.__sharedStop && window.__sharedMirror && window.__sharedSnapshot)).catch(()=>false);
  if(recorded)await page.evaluate(()=>window.__sharedSnapshot());
  else for(const frame of page.frames())await frame.evaluate(recorder).catch(() => {});
  // Puppeteer's framenavigated also fires for hash/history routing. Only a
  // new top-level document invalidates the recorder and its node IDs.
  tab.cdp.on('Page.frameNavigated', ({frame}) => {
    if (!frame.parentId) {
      tab.chooser = null;
      uploads.releaseTab(tab.id).catch(err => console.error(err.message));
      tab.generation = null;
      tab.events = [];
      tab.eventBytes = 0;
      broadcast({ type: "navigation", tab: tab.id });
      session.update().catch(() => {});
    }
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) session.update().catch(() => {});
  });
  page.on("dialog", (d) => {
    tab.dialog = d;
    broadcast({
      type: "dialog",
      tab: tab.id,
      kind: d.type(),
      message: d.message(),
      defaultValue: d.defaultValue(),
    });
  });
  page.on("close", () => {
    uploads.releaseTab(tab.id).catch(err => console.error(err.message));
    session.tabs.delete(tab.id);
    if (session.active === tab.id)
      session.active = session.tabs.keys().next().value || null;
    session.update().catch(() => {});
  });
  return tab;
}
browser.on("targetcreated", async (target) => {
  try {
    if (target.type() === "page") {
      const p = await target.page();
      if (p) {
        await attach(p);
        await session.update();
      }
    }
  } catch (err) {
    console.error("attach failed", err.message);
  }
});
for (const page of await browser.pages()) await attach(page);
// Reconnecting a receiver must follow Chrome's current page, not the first
// tab returned by CDP. Otherwise the viewer silently jumps to an older tab.
const existingVisibility=await Promise.all([...session.tabs.values()].map(async tab=>({tab,...await tab.page.evaluate(()=>({visible:document.visibilityState==='visible',focused:document.hasFocus()})).catch(()=>({}))})));
session.active=(existingVisibility.find(t=>t.visible&&t.focused)||existingVisibility.find(t=>t.visible))?.tab.id||session.active;
await downloads.start(browser);
const runtime = new AgentRuntime(session);
async function body(req, max = 200000) {
  let size = 0,
    parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Error("Request too large");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString() || "{}");
}
const authorized = (req) => req.headers["tailscale-user-login"] === owner;
const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://local");
    if (url.pathname === "/fixture") {
      // No credentials or session data on the synthetic fixture.
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      return res.end(await fs.readFile(path.join(root, "dist/fixture.html")));
    }
    if (!authorized(req))
      return json(
        res,
        {
          error:
            "This browser is private. Connect through your authorized Tailscale identity.",
        },
        403,
      );
    if (url.pathname === '/upload' && req.method === 'POST') {
      if (req.headers.origin !== publicOrigin) return json(res, {error:'Invalid upload origin'}, 403);
      if (activeUploads >= 3) return json(res, {error:'Another transfer is in progress'}, 429);
      const client = [...sockets].find(ws => ws.clientId === url.searchParams.get('client'));
      const tab = session.tabs.get(url.searchParams.get('tab'));
      const generation = url.searchParams.get('generation');
      const valid = () => client?.readyState === 1 && tab && session.tabs.get(tab.id) === tab && tab.generation === generation;
      if (!valid()) return json(res, {error:'Page or connection changed; choose your files again'}, 409);
      activeUploads++;
      let staged;
      try {
        const parts = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BATCH_BYTES + 65536) throw Error('Choose at most 20 MB in total');
          parts.push(chunk);
        }
        const data = await new Request('http://local/upload', {method:'POST',
          headers:{'content-type':req.headers['content-type'] || ''}, body:Buffer.concat(parts)}).formData();
        const files = data.getAll('files');
        if (!files.length || files.some(f => typeof f.arrayBuffer !== 'function')) throw Error('Choose a file');
        validateSizes(files);
        staged = await uploads.stage(files, tab.id, generation);
        const result = await serial(async () => {
          if (!valid() || req.aborted) throw Error('Page or connection changed; upload was not attached');
          await tab.page.bringToFront();
          const chooserId = url.searchParams.get('chooser');
          if (chooserId) {
            if (tab.chooser?.public.id !== chooserId) throw Error('File chooser changed');
            return session.chooseFiles(tab, staged.paths);
          }
          const node = Number(url.searchParams.get('node'));
          if (!Number.isInteger(node) || node <= 0) throw Error('Invalid file input');
          const handle = await tab.page.evaluateHandle(id => window.__sharedMirror?.getNode(id), node);
          try {
            const element = handle.asElement();
            if (!element) throw Error('File input no longer exists');
            return await session.setFiles(tab, element, staged.paths);
          } finally { await handle.dispose(); }
        });
        staged = null; // Chrome may read selected files later, so retain until navigation/tab close.
        return json(res, {files:result});
      } catch (err) {
        if (staged) await uploads.remove(staged.id);
        return json(res, {error:err.message}, 400);
      } finally { activeUploads--; }
    }
    if (req.method !== "GET")
      return json(res, { error: "Method not allowed" }, 405);
    if (url.pathname.startsWith('/download/')) {
      const item = downloads.items.get(url.pathname.slice('/download/'.length));
      if (!item?.path || item.status !== 'completed') return json(res, {error:'Download is not available'}, 404);
      res.writeHead(200, {'Content-Type':'application/octet-stream', 'Content-Length':item.bytes,
        'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(item.name).replace(/'/g,'%27'),
        'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"sandbox; default-src 'none'"});
      const stream = createReadStream(item.path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      return stream.pipe(res);
    }
    if (url.pathname === '/passkey-requests') {
      try {
        const response = await fetch('http://127.0.0.1:8797/agent/state', {signal:AbortSignal.timeout(1000)});
        if (!response.ok) throw Error('Passkey broker unavailable');
        return json(res, await response.json());
      } catch { return json(res, []); }
    }
    if (url.pathname === "/status") return json(res, await session.state());
    if (url.pathname === "/asset") {
      const tab=session.tabs.get(url.searchParams.get("tab"));
      const assetURL=url.searchParams.get("url");
      if(!tab || !assetURL)return json(res,{error:"Asset unavailable"},404);
      const controller=new AbortController();
      const abort=()=>controller.abort();res.once('close',abort);
      const resource=await tab.assetDelivery.get(assetURL,controller.signal);
      res.off('close',abort);
      if(controller.signal.aborted)return;
      if (!resource) return json(res, { error: "Asset unavailable" }, 404);
      const bytes=/^text\/css(?:;|$)/i.test(resource.type)
        ? Buffer.from(rewriteStylesheet(resource.bytes.toString('utf8'),tab.id,assetURL))
        : resource.bytes;
      res.writeHead(200, {
        "Content-Type": resource.type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=60",
      });
      return res.end(bytes);
    }
    const files = {
      "/": ["viewer.html", "text/html"],
      "/viewer.js": ["viewer.js", "text/javascript"],
      "/viewer.css": ["viewer.css", "text/css"],
    };
    const file = files[url.pathname];
    if (!file) return json(res, { error: "Not found" }, 404);
    const payload = await fs.readFile(path.join(root, "dist", file[0]));
    const zipped = String(req.headers["accept-encoding"] || "").includes(
      "gzip",
    );
    res.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control":
        file[0] === "viewer.html" ? "no-store" : "private, max-age=86400",
      Vary: "Accept-Encoding",
      ...(zipped ? { "Content-Encoding": "gzip" } : {}),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(zipped ? gzipSync(payload) : payload);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 200000,
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 } },
});
httpServer.on("upgrade", (req, socket, head) => {
  if (
    new URL(req.url, "http://local").pathname !== "/ws" ||
    !authorized(req) ||
    req.headers.origin !== publicOrigin
  ) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws, req) => {
  ws.clientId = randomUUID();
  sockets.add(ws);
  send(ws, { type: "hello", clientId: ws.clientId, mouseInput:1 });
  // A reconnect starts with current DOM and form properties, not a timed
  // playback of old incremental events that can leave initial fields empty.
  serial(async () => {
    const params=new URL(req.url,"http://local").searchParams;
    const width=Number(params.get("width")),height=Number(params.get("height"));
    const active=session.tabs.get(session.active);
    if(active && Number.isFinite(width) && Number.isFinite(height) && width>0 && height>0) {
      await active.page.bringToFront();
      await active.page.setViewport({width:Math.max(320,Math.min(2560,Math.round(width))),height:Math.max(400,Math.min(1600,Math.round(height)))});
    }
    send(ws, { type: "state", ...(await session.state()) });
    for (const t of session.tabs.values()) {
      await t.page.evaluate(() => window.__sharedSnapshot?.());
    }
    send(ws,{type:"ready"});
  }).catch(err => send(ws, {type:"error",message:err.message}));
  ws.on("close", () => {
    sockets.delete(ws);
    serial(()=>remoteMouse.release(ws)).catch(()=>{});
    session.update().catch(() => {});
  });
  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
      await serial(async () => {
        if (ws.readyState !== 1) throw Error("Viewer disconnected; action discarded");
        // Older viewers may still send ownership messages. They are harmless
        // compatibility no-ops; all participants share the same action queue.
        if (message.type === "take" || message.type === "give") return;
        if (message.type === "sync") {
          for (const t of session.tabs.values())
            for (const item of t.events) send(ws, item);
          return;
        }
        if (message.type === "new") {
          await session.newTab("http://127.0.0.1:" + port + "/fixture");
          return;
        }
        const t = session.tabs.get(message.tab || session.active);
        if (!t) throw Error("Tab no longer exists");
        await t.page.bringToFront();
        if (message.type === "tab") {
          session.active = t.id;
          await session.update();
          return;
        }
        if (message.type === "goto") {
          await session.navigate(t, message.url);
          return;
        }
        if (message.type === "back") {
          await t.page.goBack({ waitUntil: "domcontentloaded" });
          return;
        }
        if (message.type === "resize") {
          await t.page.setViewport({
            width: Math.max(320, Math.min(2560, Math.round(message.width))),
            height: Math.max(400, Math.min(1600, Math.round(message.height))),
          });
          return;
        }
        if (message.type === "dialog") {
          await session.handleDialog(t, message);
          return;
        }
        if (message.type==='pointer' && message.phase==='cancel') {await remoteMouse.release(ws);return;}
        if (message.generation !== t.generation) {
          await remoteMouse.release(ws);
          throw Error("Page changed; wait for the updated view");
        }
        if (message.type==='pointer') {await remoteMouse.dispatch(ws,t,message);return;}
        if (message.type === 'cancelChooser') {
          if (t.chooser?.public.id === message.chooser) {
            t.chooser = null;
            await session.update();
          }
          return;
        }
        if (message.type === "click") {
          if (Number.isInteger(message.node) && message.node > 0) {
            const handle = await t.page.evaluateHandle(
              (id) => window.__sharedMirror?.getNode(id),
              message.node,
            );
            try {
              const element = handle.asElement();
              if (!element) throw Error("Element no longer exists");
              await element.click();
            } finally {
              await handle.dispose();
            }
            return;
          }
          if (!Number.isFinite(message.x) || !Number.isFinite(message.y))
            throw Error("Invalid coordinates");
          await t.page.mouse.click(message.x, message.y);
          return;
        }
        if (message.type === "scrollTo") {
          if (![message.x,message.y,message.sequence].every(Number.isFinite) || !Number.isInteger(message.node)) throw Error("Invalid scroll position");
          const position=await t.page.evaluate(({node,x,y})=>{
            const target=window.__sharedMirror?.getNode(node);
            if (!target || (target.nodeType!==9 && !target.isConnected)) throw Error("Scroll target changed");
            const element=target.nodeType===9 ? target.scrollingElement : target;
            if (!element || typeof element.scrollTo!=="function") throw Error("Unsupported scroll target");
            element.scrollTo({left:x,top:y,behavior:"instant"});
            return {x:element.scrollLeft,y:element.scrollTop};
          },message);
          send(ws,{type:"scrollResult",tab:t.id,generation:t.generation,node:message.node,sequence:message.sequence,...position});
          return;
        }
        if (message.type === "scroll") {
          await t.page.mouse.move(
            Math.max(0, Number(message.x) || 0),
            Math.max(0, Number(message.y) || 0),
          );
          await t.page.mouse.wheel({
            deltaX: Number(message.dx) || 0,
            deltaY: Number(message.dy) || 0,
          });
          return;
        }
        if (message.type === "key") {
          await t.page.keyboard.press(message.key);
          return;
        }
        if (message.type === "fill" || message.type === "select") {
          await t.page.evaluate(
            ({ id, value, type }) => {
              const e = window.__sharedMirror?.getNode(id);
              if (!e || !e.isConnected) throw Error("Field no longer exists");
              if (!/INPUT|TEXTAREA|SELECT/.test(e.tagName))
                throw Error("Unsupported input");
              if (e.type === "file")
                throw Error("Use the file picker to select files");
              e.focus();
              const proto =
                e.tagName === "TEXTAREA"
                  ? HTMLTextAreaElement.prototype
                  : e.tagName === "SELECT"
                    ? HTMLSelectElement.prototype
                    : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, "value").set.call(
                e,
                value,
              );
              e.dispatchEvent(new Event("input", { bubbles: true }));
              e.dispatchEvent(new Event("change", { bubbles: true }));
            },
            {
              id: message.node,
              value: String(message.value).slice(0, 50000),
              type: message.type,
            },
          );
          return;
        }
        throw Error("Unsupported viewer action");
      });
      send(ws, { type: "ack", requestId: message.requestId });
    } catch (err) {
      send(ws, {
        type: "error",
        requestId: message?.requestId,
        message: err.message,
      });
    }
  });
});
const rpc = http.createServer(async (req, res) => {
  try {
    const b = await body(req);
    if (req.url === "/js")
      return json(res, {
        content: await runtime.execute(b.context || "default", b.code),
      });
    if (req.url === "/reset")
      return json(res, runtime.reset(b.context || "default"));
    if (req.url === "/state") return json(res, await session.state());
    if (req.url === "/stop") {
      json(res, { stopping: true });
      setTimeout(stop, 50);
      return;
    }
    json(res, { error: "Unknown RPC" }, 404);
  } catch (err) {
    json(res, { error: err.message }, 400);
  }
});
const socketPath = path.join(stateDir, "server.sock");
await fs.unlink(socketPath).catch((e) => {
  if (e.code !== "ENOENT") throw e;
});
await new Promise((resolve) => rpc.listen(socketPath, resolve));
await fs.chmod(socketPath, 0o600);
await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
await fs.writeFile(
  path.join(stateDir, "session.json"),
  JSON.stringify({
    pid: process.pid,
    socketPath,
    port,
    viewerUrl: publicOrigin + "/",
    startedAt: new Date().toISOString(),
  }),
  { mode: 0o600 },
);
const first = session.tabs.values().next().value;
if (first && first.page.url() === "about:blank")
  await session.navigate(first, "http://127.0.0.1:" + port + "/fixture");
console.log(JSON.stringify({ event: "ready", url: publicOrigin, port }));
async function stop() {
  if (!running) return;
  running = false;
  for (const ws of sockets) ws.close();
  if(externalBrowserURL || managedEndpoint)await browser.disconnect();
  else await browser.close();
  await fs.rm(transferDir, {recursive:true, force:true});
  rpc.close();
  httpServer.close();
  await fs.unlink(socketPath).catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
browser.on("disconnected", () => {
  if (running) {
    console.error("Chrome disconnected; session stopped");
    process.exit(1);
  }
});
