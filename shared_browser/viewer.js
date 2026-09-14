import { ViewerShell } from "./viewer-shell.js";
import { rewriteAssets } from "./replay-assets.mjs";
import { controlVisibility } from "./control-visibility.js";
import { ViewerPasskeys } from "./viewer-passkeys.js";
import { ViewerTransfers } from "./viewer-transfers.js";
import { AgentPointer } from "./agent-pointer.js";
import { ScrollSync } from "./scroll-sync.mjs";
import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";

const $ = (id) => document.getElementById(id);
let ws,
  clientId,
  state,
  active,
  generation,
  replayer,
  scale = 1,
  connected = false;
const shell = new ViewerShell();
const transfers = new ViewerTransfers({context:()=>({tab:active,generation,client:clientId,connected}),send:message=>send(message),error:message=>error(message)});
const passkeys = new ViewerPasskeys();
const caches = new Map();
const agentPointer=new AgentPointer(document.getElementById("viewport"));
let retries = 0;
function error(message) {
  $("error").textContent = message;
}
const pendingFills = new Map();
let fillTimer;
function queueFill(node, value) {
  pendingFills.set(node, {type:"fill",node,value,tab:active,generation});
  if (!fillTimer) fillTimer=setTimeout(flushFills,40);
}
function flushFills() {
  clearTimeout(fillTimer); fillTimer=null;
  const batch=[...pendingFills.values()]; pendingFills.clear();
  for (const message of batch) send(message);
}
const scrollSync=new ScrollSync();
const scrollEchoes=new Map();
let pendingScroll, scrollTimer, momentumFrame, ready=false;
function flushScroll() {
  clearTimeout(scrollTimer);scrollTimer=null;
  if (pendingScroll) { const next=pendingScroll;pendingScroll=null;send(next); }
}
function scrollTarget(x,y,dx,dy) {
  const doc=replayer?.iframe.contentDocument;
  if (!doc) return null;
  let node=doc.elementFromPoint(x,y);
  while (node && node!==doc.documentElement) {
    const css=doc.defaultView.getComputedStyle(node);
    if ((/auto|scroll/.test(css.overflowY) && node.scrollHeight>node.clientHeight &&
         ((dy<0 && node.scrollTop>0)||(dy>0 && node.scrollTop<node.scrollHeight-node.clientHeight))) ||
        (/auto|scroll/.test(css.overflowX) && node.scrollWidth>node.clientWidth && dx)) return node;
    node=node.parentElement;
  }
  return doc;
}
function localScroll(target,dx,dy) {
  if (!connected || !target) return;
  const doc=replayer.iframe.contentDocument;
  const element=target.nodeType===9 ? target.scrollingElement : target;
  if (!element) return;
  const x=Math.max(0,Math.min(element.scrollWidth-element.clientWidth,element.scrollLeft+dx));
  const y=Math.max(0,Math.min(element.scrollHeight-element.clientHeight,element.scrollTop+dy));
  const node=replayer.getMirror().getId(target);
  if (node<0) return;
  (target.nodeType===9 ? doc.defaultView : target).scrollTo({left:x,top:y,behavior:"instant"});
  // Move controls before the next paint, together with the replay document.
  wireFrame();
  const position=scrollSync.update(node,x,y);
  scrollEchoes.set(node,{x,y,until:performance.now()+1000});
  if (pendingScroll && pendingScroll.node!==node) flushScroll();
  pendingScroll={type:"scrollTo",...position,tab:active,generation};
  if (!scrollTimer) scrollTimer=setTimeout(flushScroll,50);
}
function reveal() {
  if (ready && Number(replayer?.iframe.width)===lastWidth && replayer?.iframe.contentDocument?.body && overlay) {
    $("viewport").style.visibility="visible";
  }
}
function send(message) {
  if (message.type!=="scrollTo" && pendingScroll) flushScroll();
  if (message.type!=="fill" && pendingFills.size) flushFills();
  if (!connected) {
    error("Disconnected. Reconnecting without replaying input…");
    return;
  }
  ws.send(
    JSON.stringify({
      tab: active,
      generation,
      ...message,
      requestId: crypto.randomUUID(),
    }),
  );
}
function own() {
  return connected;
}
function dimensions() {
  return {
    width: Math.max(320,Math.min(2560,Math.floor(window.innerWidth))),
    height: Math.max(400, window.innerHeight),
  };
}
function fit() {
  if (!replayer) return;
  const iframe = replayer.iframe;
  const width = Number(iframe.width) || 1280,
    height = Number(iframe.height) || 800;
  scale = Math.min(1, innerWidth / width);
  $("replay").style.transform = `scale(${scale})`;
  $("viewport").style.width = width * scale + "px";
  $("viewport").style.height = height * scale + "px";
  if (overlay) overlay.style.transform = `scale(${scale})`;
  agentPointer.layer.style.transform=`scale(${scale})`;
}
function rewrite(event, tab) {
  return rewriteAssets(event,tab,state?.tabs.find(t=>t.id===tab)?.url);
}
// Keep browser-native controls in the parent document. Sandboxed replay frames
// are visual-only: Safari blocks parent-installed handlers inside those frames.
const controls = new Map();
let overlay, overlayGeneration, layoutFrame;
function scheduleLayout() {
  if (layoutFrame) return;
  layoutFrame=requestAnimationFrame(() => {layoutFrame=null;wireFrame();});
}
function wireFrame() {
  const doc = replayer?.iframe.contentDocument;
  if (!doc?.documentElement) return;
  if (!overlay || !overlay.isConnected) {
    overlay = document.createElement("div");
    overlay.id = "interaction-layer";
    overlay.style.cssText = "position:absolute;inset:0;transform-origin:top left;z-index:2";
    $("viewport").append(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target !== overlay) return;
      const r = overlay.getBoundingClientRect();
      const x = (e.clientX-r.left)/scale, y = (e.clientY-r.top)/scale;
      const target = replayer.iframe.contentDocument.elementFromPoint(x,y);
      if (target) send({type:"click",...(target.tagName === "IFRAME" ? {} : {node:replayer.getMirror().getId(target)}),x,y});
    });
    const point=e => {const r=overlay.getBoundingClientRect();return {x:(e.clientX-r.left)/scale,y:(e.clientY-r.top)/scale};};
    overlay.addEventListener("wheel", e => {
      e.preventDefault();cancelAnimationFrame(momentumFrame);
      const p=point(e), factor=e.deltaMode===1 ? 16 : e.deltaMode===2 ? innerHeight : 1;
      localScroll(scrollTarget(p.x,p.y,e.deltaX,e.deltaY),e.deltaX*factor/scale,e.deltaY*factor/scale);
    }, {passive:false});
    let touch, target, velocity={x:0,y:0}, lastTime=0, moved=false;
    overlay.addEventListener("touchstart", e => {
      cancelAnimationFrame(momentumFrame);moved=false;
      if (e.touches.length!==1 || ["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) {touch=null;return;}
      touch=e.touches[0];target=null;lastTime=performance.now();velocity={x:0,y:0};
    }, {passive:true});
    overlay.addEventListener("touchmove", e => {
      if (!touch || e.touches.length!==1) return;
      const next=e.touches[0],dx=(touch.clientX-next.clientX)/scale,dy=(touch.clientY-next.clientY)/scale;
      if (!moved && Math.abs(dx)+Math.abs(dy)<3) return;
      e.preventDefault();moved=true;
      const p=point(touch);target ||= scrollTarget(p.x,p.y,dx,dy);
      const now=performance.now(),dt=Math.max(8,now-lastTime);
      velocity={x:dx/dt,y:dy/dt};lastTime=now;
      localScroll(target,dx,dy);touch=next;
    }, {passive:false});
    overlay.addEventListener("click",e=>{if(moved){e.preventDefault();e.stopImmediatePropagation();moved=false;}},true);
    overlay.addEventListener("touchend",()=>{
      touch=null;if (!moved || performance.now()-lastTime>100) {flushScroll();return;}
      let previous=performance.now();
      const coast=now=>{
        const dt=Math.min(32,now-previous);previous=now;
        const decay=Math.exp(-dt/180);velocity.x*=decay;velocity.y*=decay;
        if(Math.abs(velocity.x)+Math.abs(velocity.y)<0.02){flushScroll();return;}
        localScroll(target,velocity.x*dt,velocity.y*dt);
        momentumFrame=requestAnimationFrame(coast);
      };
      momentumFrame=requestAnimationFrame(coast);
    });
    overlay.addEventListener("touchcancel",()=>{touch=null;cancelAnimationFrame(momentumFrame);flushScroll();});
  }
  if (overlayGeneration !== generation) {
    overlay.replaceChildren(); controls.clear(); overlayGeneration=generation;
  }
  overlay.style.width = replayer.iframe.width+"px";
  overlay.style.height = replayer.iframe.height+"px";
  overlay.style.transform = `scale(${scale})`;
  const seen = new Set();
  for (const source of doc.querySelectorAll("input,textarea,select,button,a[href]")) {
    if (source.type === "hidden") continue;
    const visible=controlVisibility(source);
    if (!visible) continue;
    const {rect,clip}=visible;
    source.setAttribute("aria-hidden", "true");
    source.tabIndex=-1;
    const id=replayer.getMirror().getId(source);
    seen.add(id);
    const fileInput=source.type === "file";
    const clickable=source.tagName==="BUTTON" || source.tagName==="A" ||
      ["checkbox","radio","submit","button"].includes(source.type);
    // Only the native parent control draws editable text. Drawing its replay
    // copy too produces visible ghosts when scroll positions briefly differ.
    if (!clickable) source.style.opacity="0";
    let field=controls.get(id);
    if (!field) {
      field=document.createElement(clickable || fileInput ? "button" : source.tagName);
      if (source.tagName==="INPUT" && !clickable && !fileInput) field.type=source.type;
      if (clickable) field.addEventListener("click", () => send({type:"click",node:id}));
      if (fileInput) field.addEventListener('click', () => transfers.pick({node:id,multiple:source.multiple,accept:source.accept}));
      field.dataset.node=id;
      field.addEventListener("input", () => {if (!fileInput) queueFill(id,field.value);});
      field.addEventListener("blur", flushFills);
      field.addEventListener("change", () => {
        if (field.tagName==="SELECT") send({type:"select",node:id,value:field.value});
      });
      field.addEventListener("keydown", e => {
        if (e.key==="Enter" && field.tagName==="INPUT") {
          e.preventDefault(); send({type:"key",key:e.key});
        }
      });
      controls.set(id,field); overlay.append(field);
    }
    const css=doc.defaultView.getComputedStyle(source);
    // Cache style/options signatures: assigning unchanged styles and rebuilding
    // a native select on every mouse/scroll event disrupts mobile interaction.
    const styleNames=["font","color","background-color","border-top","border-right","border-bottom","border-left","border-radius",
      "outline","outline-offset","box-shadow","padding","text-align","box-sizing","line-height","letter-spacing","appearance"];
    const styleSignature=styleNames.map(name=>css.getPropertyValue(name)).join(";");
    if (field.dataset.styleSignature!==styleSignature) {
      field.dataset.styleSignature=styleSignature;
    for (const name of styleNames) {
      field.style.setProperty(name,css.getPropertyValue(name));
    }
    }
    Object.assign(field.style,{position:"absolute",margin:"0",left:rect.left+"px",
      top:rect.top+"px",width:rect.width+"px",height:rect.height+"px",clipPath:clip});
    field.setAttribute("aria-label",source.getAttribute("aria-label") ||
      [...(source.labels||[])].map(l=>l.textContent.trim()).join(" ") || source.textContent.trim() || source.name || "Field");
    if (clickable) {
      field.style.opacity="0";
      field.style.cursor="pointer";
    }
    field.placeholder=source.placeholder || "";
    field.disabled=source.disabled || !connected;
    field.readOnly=source.readOnly;
    const optionsSignature=field.tagName==="SELECT" ? [...source.options].map(o=>[o.value,o.textContent,o.disabled]) : null;
    if (optionsSignature && field.dataset.optionsSignature!==JSON.stringify(optionsSignature) && document.activeElement!==field) {
      field.dataset.optionsSignature=JSON.stringify(optionsSignature);
      field.replaceChildren(...[...source.options].map(o=>{
        const option=document.createElement("option"); option.value=o.value;
        option.textContent=o.textContent; option.disabled=o.disabled; return option;
      }));
    }
    if (fileInput) {
      field.textContent = source.getAttribute('data-shared-file-names') || (source.multiple ? 'Choose files…' : 'Choose file…');
      field.disabled ||= source.hasAttribute('webkitdirectory');
      field.style.cursor = 'pointer';
    } else if (document.activeElement!==field) field.value=source.value;
  }
  for (const [id,field] of controls) if (!seen.has(id)) {field.remove();controls.delete(id);}
  agentPointer.refresh();
  reveal();
}
function showTab(id) {
  const changed=active!==id;
  agentPointer.reset();
  cancelAnimationFrame(momentumFrame);scrollSync.clear();
  if (replayer) {
    replayer.destroy();
    replayer = null;
  }
  $("replay").replaceChildren();
  overlay?.remove(); overlay=null; controls.clear();
  active = id;
  if(changed && connected && id) {
    const size=dimensions();lastWidth=size.width;
    $("viewport").style.visibility="hidden";
    // New agent tabs otherwise retain Chrome's launch viewport until the
    // next viewer resize/reconnect. Request sizing once per tab switch.
    send({type:'resize',...size});
  }
  const cache = caches.get(id);
  if (!cache?.events.some((e) => e.type === 2)) return;
  generation = cache.generation;
  replayer = new Replayer(
    cache.events.map((e) => rewrite(e, id)),
    {
      root: $("replay"),
      liveMode: true,
      // rrweb's synchronous virtual-DOM rebuild loses iframe documents and
      // image data during reconnect. Build directly into the sandboxed DOM.
      useVirtualDom: false,
      // This is a live page, not a paused recording. Let CSS spinners and
      // other stylesheet animations run even while no DOM events arrive.
      pauseAnimation: false,
      mouseTail: false,
      showWarning: false,
      UNSAFE_replayCanvas: false,
    },
  );
  replayer.on("fullsnapshot-rebuilded", () => {
    fit();
    scheduleLayout();
  });
  replayer.on("resize", () => {fit();scheduleLayout();});
  replayer.iframe.addEventListener("load", scheduleLayout);
  // rrweb defaults to smooth scrolling. The controls and page must instead
  // move together in one frame. This adapter is for the pinned rrweb 2.1.4 API.
  const applyScroll=replayer.applyScroll.bind(replayer);
  replayer.applyScroll=(data) => {
    if (scrollSync.pending.has(data.id)) return;
    const echo=scrollEchoes.get(data.id);
    if(echo && performance.now()<echo.until) return;
    scrollEchoes.delete(data.id);applyScroll(data,true);
  };
  replayer.on("event-cast", event => {
    if (event.type===3 && event.data.source===5) {
      const field=controls.get(event.data.id);
      if (field && field.tagName!=="BUTTON" && document.activeElement!==field && !pendingFills.has(event.data.id)) {
        field.value=event.data.text;
      }
      return;
    }
    if (event.type===2 || (event.type===3 && [0,3,4,8,13].includes(event.data.source))) scheduleLayout();
  });
  replayer.startLive();
  replayer.disableInteract();
  replayer.iframe.style.border = "0";
  setTimeout(() => {
    fit();
    scheduleLayout();
  }, 100);
}
function eventReceived(message) {
  // Remote focus echoes must never steal the iPhone keyboard from its native
  // parent input. Focus belongs to the viewer; field values still synchronize.
  if (message.event.type===3 && message.event.data.source===2 &&
      [5,6].includes(message.event.data.type)) return;
  let cache = caches.get(message.tab);
  if (!cache) {
    cache = { events: [], generation: message.generation };
    caches.set(message.tab, cache);
  }
  if (message.event.type === 2) {
    cache.events = cache.events.filter((e) => e.type === 4).slice(-1);
    cache.generation = message.generation;
  }
  cache.events.push(message.event);
  if (message.tab === active) {
    generation = cache.generation;
    if (!replayer) {
      showTab(active);
    } else {
      replayer.addEvent(rewrite(message.event, active));
    }
  }
}
function update(next) {
  state = next;
  $("take").disabled = !connected || own();
  $("give").disabled = !own();

  for (const id of ["go", "new", "back", "url"]) $(id).disabled = !connected;
  $("connection").textContent = connected
    ? "Connected"
    : "Reconnecting…";
  shell.update({connected,message:next.message});
  const tabs = $("tabs");
  tabs.replaceChildren(
    ...next.tabs.map((t) => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.title || t.url;
      return o;
    }),
  );
  const selected = next.activeTab;
  if (selected !== active) showTab(selected);
  tabs.value = active || "";
  transfers.update(next);
  if (document.activeElement !== $("url"))
    $("url").value = next.tabs.find((t) => t.id === active)?.url || "";
}
function connect() {
  ready=false;$("viewport").style.visibility="hidden";
  const size=dimensions();lastWidth=size.width;
  ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws?"+new URLSearchParams(size));
  ws.onopen = () => {
    connected = true;
    retries = 0;
    error("");
    caches.clear();
    if (replayer) {
      replayer.destroy();
      replayer = null;
    }
    active = null;
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if(m.type==="agentActivity" && m.tab===active && m.generation===generation) {
        agentPointer.handle(m,node=>{
          const element=replayer?.getMirror().getNode(node);
          if(!element?.getBoundingClientRect)return null;
          const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};
        });
      }
      if (m.type === "ready") {ready=true;reveal();}
      if (m.type === "scrollResult" && m.tab===active && m.generation===generation && scrollSync.acknowledge(m)) {
        // Authoritative clamping (e.g. content shrank) corrects only the latest gesture.
        const node=replayer?.getMirror().getNode(m.node);
        const target=node?.nodeType===9 ? node.defaultView : node;
        target?.scrollTo({left:m.x,top:m.y,behavior:"instant"});scheduleLayout();
      }
      if (m.type === "hello") clientId = m.clientId;
      if (m.type === "state") update(m);
      if (m.type === "event") eventReceived(m);
      // Keep the last rendered document until replacement events arrive.
      // Older servers also announce hash/history changes as navigation: those
      // only emit incremental mutations, not a fresh full snapshot. Clearing
      // here stranded the viewer on a blank page until reconnect.
      // For real document changes, the next full snapshot replaces the cache;
      // server generation checks reject any stale input in the meantime.
      if (m.type === "error") error(m.message);
      if (m.type === "dialog") {
        $("dialog").style.display = "block";
        $("dialog").querySelector("span").textContent = m.message;
        $("dialog").querySelector("input").value = m.defaultValue || "";
      }
    } catch (e) {
      error("Viewer update failed: " + e.message);
    }
  };
  ws.onclose = () => {
    connected = false;shell.update({connected,message:state?.message});agentPointer.reset();transfers.disconnect();
    clearTimeout(fillTimer);fillTimer=null;pendingFills.clear();
    clearTimeout(scrollTimer);scrollTimer=null;pendingScroll=null;
    cancelAnimationFrame(momentumFrame);scrollSync.clear();
    $("connection").textContent = "Disconnected · reconnecting…";
    $("take").disabled = true;
    $("give").disabled = true;
    setTimeout(connect, Math.min(10000, 500 * 2 ** retries++));
  };
}
$("take").onclick = () => send({ type: "take", ...dimensions() });
$("give").onclick = () => send({ type: "give" });
$("go").onclick = () => {
  let url = $("url").value;
  if (!/^https?:|^about:/.test(url)) url = "https://" + url;
  send({ type: "goto", url });
};
$("url").onkeydown = (e) => {
  if (e.key === "Enter") $("go").click();
};
$("back").onclick = () => send({ type: "back" });
$("new").onclick = () => send({ type: "new" });
$("tabs").onchange = () => {
  send({ type: "tab", tab: $("tabs").value });
};
for (const accept of [true, false])
  $("dialog-" + (accept ? "ok" : "cancel")).onclick = () => {
    send({
      type: "dialog",
      accept,
      text: $("dialog").querySelector("input").value,
    });
    $("dialog").style.display = "none";
  };
let resizeTimer,lastWidth;
addEventListener("resize", () => {
  fit();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const size=dimensions();
    // Keyboard/address-bar height changes must not reflow the shared website.
    if (own() && size.width!==lastWidth) {lastWidth=size.width;send({type:"resize",...size});}
  }, 300);
});
connect();
