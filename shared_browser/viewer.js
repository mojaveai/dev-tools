import { ViewerShell } from "./viewer-shell.js";
import { rewriteAssets } from "./replay-assets.mjs";
import { controlOcclusion } from "./control-occlusion.js";
import { relayMouse } from "./viewer-mouse.js";
import { controlVisibility } from "./control-visibility.js";
import { ViewerPasskeys } from "./viewer-passkeys.js";
import { ViewerTransfers } from "./viewer-transfers.js";
import { AgentPointer } from "./agent-pointer.js";
import { ScrollSync } from "./scroll-sync.mjs";
import { ForeignObjectTransforms } from "./foreign-object.js";
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
let mouseRelay,mouseSupported=false;
const transfers = new ViewerTransfers({context:()=>({tab:active,generation,client:clientId,connected}),send:message=>send(message),error:message=>error(message)});
const passkeys = new ViewerPasskeys();
const caches = new Map();
const agentPointer=new AgentPointer(document.getElementById("viewport"));
const webkit=/AppleWebKit/.test(navigator.userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent);
let foreignObjects, foreignObjectsDirty=true;
let retries = 0;
let noticeTimer;
function error(message, transient=false) {
  clearTimeout(noticeTimer);
  $("error").classList.toggle("notice", transient);
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
let pendingScroll, scrollTimer, momentumFrame, ready=false, awaitingSnapshot=false;
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
  // A shared source can be sized by another viewer; wait for its fresh snapshot,
  // not an exact match to this device's requested width. fit() scales the result.
  if (ready && !awaitingSnapshot && Number(replayer?.iframe.width)>0 && replayer?.iframe.contentDocument?.body && overlay) {
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
  const requestId=crypto.randomUUID();
  ws.send(
    JSON.stringify({
      tab: active,
      generation,
      ...message,
      requestId,
    }),
  );
  return requestId;
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
const sourceOpacity=new WeakMap();
let overlay, overlayGeneration, layoutFrame;
function scheduleLayout() {
  if (layoutFrame) return;
  layoutFrame=requestAnimationFrame(() => {layoutFrame=null;wireFrame();});
}
function wireFrame() {
  const doc = replayer?.iframe.contentDocument;
  if (!doc?.documentElement) return;
  if(webkit) {
    if(foreignObjects?.doc!==doc){foreignObjects=new ForeignObjectTransforms(doc);foreignObjectsDirty=true;}
    if(foreignObjectsDirty){foreignObjects.refresh();foreignObjectsDirty=false;}
  }
  if (!overlay || !overlay.isConnected) {
    overlay = document.createElement("div");
    overlay.id = "interaction-layer";
    overlay.style.cssText = "position:absolute;inset:0;transform-origin:top left;z-index:2";
    $("viewport").append(overlay);
    mouseRelay=relayMouse(overlay,{enabled:()=>connected && mouseSupported,
      context:()=>({tab:active,generation}),
      point:e=>{const r=overlay.getBoundingClientRect();return {x:(e.clientX-r.left)/scale,y:(e.clientY-r.top)/scale};},send});
    overlay.addEventListener("click", (e) => {
      if (e.target !== overlay) return;
      if(mouseRelay.consumesClick(e))return;
      const r = overlay.getBoundingClientRect();
      const x = (e.clientX-r.left)/scale, y = (e.clientY-r.top)/scale;
      // A replay iframe can ignore pointer hit-testing. elementFromPoint then
      // returns an unrelated ancestor; clicking that node relocates the user's
      // tap to its center. Preserve the actual point for all interaction-layer taps.
      send({type:"click",x,y});
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
  const occlusion=controlOcclusion(doc);
  const visibilityCache=new WeakMap(), plans=[], restore=[];
  try {
  // Current receivers accept pointer coordinates for links/buttons directly.
  // Form inputs keep browser-native controls for Safari's keyboard, touch
  // targeting and file picker. Avoid measuring hundreds of invisible copies
  // of links and chart labels on every scroll frame.
  const candidates=mouseSupported ? 'input,textarea,select' : 'input,textarea,select,button,a[href]';
  for (const source of doc.querySelectorAll(candidates)) {
    if (source.type === "hidden") continue;
    const visible=controlVisibility(source,visibilityCache);
    if (!visible || !occlusion.visible(source,visible)) {
      // The replay itself must paint the field behind its modal/popover.
      const original=sourceOpacity.get(source);
      if(original)restore.push({source,original});
      continue;
    }
    plans.push({source,...visible});
  }
  } finally {occlusion.dispose();}
  // Finish all replay geometry reads before any DOM/style writes. Alternating
  // them forces a new layout for each link or form field on the page.
  for(const {source,original} of restore){source.style.setProperty('opacity',original.value,original.priority);sourceOpacity.delete(source);}
  for(const {source,rect,clip,css} of plans) {
    if(source.getAttribute('aria-hidden')!=='true')source.setAttribute("aria-hidden", "true");
    if(source.tabIndex!==-1)source.tabIndex=-1;
    const id=replayer.getMirror().getId(source);
    seen.add(id);
    const fileInput=source.type === "file";
    const clickable=source.tagName==="BUTTON" || source.tagName==="A" ||
      ["checkbox","radio","submit","button"].includes(source.type);
    // Only the native parent control draws editable text. Drawing its replay
    // copy too produces visible ghosts when scroll positions briefly differ.
    if (!clickable) {
      if(!sourceOpacity.has(source))sourceOpacity.set(source,{value:source.style.getPropertyValue('opacity'),priority:source.style.getPropertyPriority('opacity')});
      if(source.style.opacity!=="0")source.style.opacity="0";
    }
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
  mouseRelay?.dispose();mouseRelay=null;
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
    awaitingSnapshot=true;
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
    foreignObjects=null;foreignObjectsDirty=true;
    fit();
    scheduleLayout();
  });
  replayer.on("resize", () => {foreignObjectsDirty=true;foreignObjects?.refresh(true);fit();scheduleLayout();});
  replayer.iframe.addEventListener("load", scheduleLayout);
  // rrweb defaults to smooth scrolling. The controls and page must instead
  // move together in one frame. This adapter is for the pinned rrweb 2.1.4 API.
  replayer.applyScroll=(data) => {
    if (scrollSync.pending.has(data.id)) return;
    const echo=scrollEchoes.get(data.id);
    if(echo && performance.now()<echo.until) return;
    scrollEchoes.delete(data.id);
    const node=replayer.getMirror().getNode(data.id);
    const target=node?.nodeType===9 ? node.defaultView : node;
    // rrweb's "sync" path uses behavior:auto, which still obeys a site's
    // scroll-behavior:smooth. Incoming positions must not start animations
    // that fight later scroll frames or local gestures.
    target?.scrollTo?.({left:data.x,top:data.y,behavior:'instant'});
  };
  replayer.on("event-cast", event => {
    if(event.type===2 || (event.type===3 && [0,8,13].includes(event.data.source)))foreignObjectsDirty=true;
    if(event.type===3 && [8,13].includes(event.data.source))foreignObjects?.refresh(true);
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
  if (message.tab===active && message.event.type===2) awaitingSnapshot=false;
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
    if(message.tab===active && generation!==message.generation) {
      agentPointer.reset();scrollSync.clear();scrollEchoes.clear();
      clearTimeout(scrollTimer);scrollTimer=null;pendingScroll=null;
      cancelAnimationFrame(momentumFrame);
    }
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
      if(m.type==='ack' || m.type==='error')mouseRelay?.acknowledge(m.requestId);
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
      if (m.type === "hello") {clientId = m.clientId;mouseSupported=m.mouseInput===1;}
      if (m.type === "state") update(m);
      if (m.type === "event") eventReceived(m);
      // Keep the last rendered document until replacement events arrive.
      // Older servers also announce hash/history changes as navigation: those
      // only emit incremental mutations, not a fresh full snapshot. Clearing
      // here stranded the viewer on a blank page until reconnect.
      // For real document changes, the next full snapshot replaces the cache;
      // server generation checks reject any stale input in the meantime.
      if (m.type === "error") {
        if (m.code === "STALE_VIEW" || /^(Page|Tab) changed; wait for the updated view$/.test(m.message)) {
          // The rejected input is never replayed against a different document.
          // Navigation races need a brief retry notice, not a permanent error.
          error("Page changed. Please try that action again.", true);
          noticeTimer=setTimeout(() => error(""), 4000);
        } else error(m.message);
      }
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
    mouseSupported=false;
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
