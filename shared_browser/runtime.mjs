import vm from "node:vm";
import { parse } from "acorn";
import { AsyncLocalStorage } from "node:async_hooks";

export const instructions = `Shared remote Chrome control on this host. Use the viewerUrl from cua.getState() to identify the host and share viewing access. Use js with persistent JavaScript bindings and await. First call: await cua.getState(). Then const browser = await cua.getBrowser(); const tab = await browser.tabs.get(TAB_ID), or await cua.getTab(TAB_ID). Browser supports tabs.list(), tabs.new(url), tabs.get(id). Tab supports goto(url), getState(), getAXState(), domSnapshot(), screenshot(), getScreenshot(), back(), forward(), reload(), close(), click(nodeIdOrSelectorOrCoordinates), setValue(nodeId,text), typeText(text), type(selector,text), pressKey(key), scroll({x,y}), select(selector,value), handleDialog({accept,text}), setFiles(nodeIdOrSelector,absoluteRemotePaths), chooseFiles(absoluteRemotePaths) for a pending custom picker, getDownloads(). tab.playwright.getByRole(role,{name,exact}), getByText(text,{exact}), getByLabel(text), locator(css) support click(), fill(text), innerText(), count(). Coordinates use tab.click([x,y]) in source viewport CSS pixels and work inside cross-origin frames. This locator syntax is optional; plain tab methods work. nodeRepl.write(value) emits observations. nodeRepl.emitImage(await tab.screenshot()) emits an image. cua.requestHumanInput(message) displays a request in the viewer without locking either participant. cua.getState() includes the authenticated viewer URL and active controller. Humans and agents share access; actions execute in order. Re-observe before acting and after reconnect. No actions are automatically replayed. js_reset clears bindings without closing Chrome. Uploads support up to 10 files, 10 MB each and 20 MB total. Paths refer to the remote browser host. Download records include private remote paths when complete. This is a browser-only pilot. Do not claim support for native desktop apps, hardware passkey forwarding, or unsupported rendered content.`;

function names(pattern) {
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((p) => names(p.value || p.argument));
  if (pattern.type === "ArrayPattern")
    return pattern.elements.filter(Boolean).flatMap(names);
  if (pattern.type === "AssignmentPattern") return names(pattern.left);
  if (pattern.type === "RestElement") return names(pattern.argument);
  return [];
}

export class AgentRuntime {
  constructor(session) {
    this.session = session;
    this.contexts = new Map();
    this.calls = new AsyncLocalStorage();
  }
  reset(id) {
    this.contexts.delete(id);
    return { reset: true, browserPreserved: true };
  }
  async execute(id, code) {
    if (typeof code !== "string" || code.length > 100000)
      throw Error("Invalid JavaScript");
    let ctx = this.contexts.get(id);
    if (!ctx) {
      ctx = vm.createContext({});
      this.contexts.set(id, ctx);
    }
    const output = [];
    const run = { active: true };
    const s = this.session;
    const write = (value) =>
      output.push({
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      });
    const mutation = (fn) => {
      const call = this.calls.getStore();
      if (!call?.active) throw Error("Expired tool call");
      return s.agentAction(async () => {
        if (!call.active) throw Error("Expired tool call");
        return fn();
      });
    };
    const performMutation = mutation;
    const wrap = (tab) => {
      const page = tab.page;
      const mutation = (fn) => performMutation(async () => {
        await page.bringToFront();
        return fn();
      });
      const feedback=(kind,element,fn)=>s.feedback ? s.feedback(tab,element,kind,fn) : fn();
      const clickElement=e=>feedback("click",e,()=>e.click());
      const byNode = async (id, fn) => {
        const h = await page.evaluateHandle(
          (id) => window.__sharedMirror?.getNode(id),
          id,
        );
        try {
          const e = h.asElement();
          if (!e) throw Error("Node is stale; observe the page again");
          return await fn(e);
        } finally {
          await h.dispose();
        }
      };
      const ax = async () => {
        const snap = await s.snapshot(tab);
        return (
          `Tab ${tab.id}: ${snap.title}\nURL: ${page.url()}\nDocument: ${tab.generation}\n${snap.text}\n\nInteractive elements (node IDs):\n` +
          snap.elements
            .map(
              (e) =>
                `${e.node} ${e.role || e.tag.toLowerCase()} ${JSON.stringify(e.label || e.text || e.id)}${e.value !== undefined ? " value=" + JSON.stringify(e.value) : ""}`,
            )
            .join("\n")
        );
      };
      const locator = (kind, value, options = {}) => {
        const query = async () => {
          if (kind === "css") return page.$$(value);
          const handle = await page.evaluateHandle(
            ({ kind, value, options }) => {
              const text = (e) => (e.innerText || e.textContent || "").trim();
              const match = (t) =>
                options.exact ? t === value : t.includes(value);
              const role = (e) =>
                e.getAttribute("role") ||
                {
                  BUTTON: "button",
                  A: "link",
                  SELECT: "combobox",
                  TEXTAREA: "textbox",
                }[e.tagName] ||
                (e.tagName === "INPUT"
                  ? e.type === "checkbox"
                    ? "checkbox"
                    : e.type === "radio"
                      ? "radio"
                      : "textbox"
                  : "");
              return [...document.querySelectorAll("*")].filter((e) => {
                if (!e.getClientRects().length) return false;
                if (kind === "text")
                  return (
                    match(text(e)) &&
                    ![...e.children].some((c) => match(text(c)))
                  );
                const label =
                  e.getAttribute("aria-label") ||
                  [...(e.labels || [])].map(text).join(" ") ||
                  text(e);
                if (kind === "label")
                  return (
                    match(label) && /INPUT|TEXTAREA|SELECT/.test(e.tagName)
                  );
                return (
                  role(e) === value &&
                  (!options.name ||
                    (options.exact
                      ? label === options.name
                      : label.includes(options.name)))
                );
              });
            },
            { kind, value, options },
          );
          const props = await handle.getProperties();
          const nodes = [...props.values()].filter((h) => h.asElement());
          await handle.dispose();
          return nodes;
        };
        const one = async (fn) => {
          const nodes = await query();
          try {
            if (nodes.length !== 1)
              throw Error(
                `Expected one matching element, found ${nodes.length}`,
              );
            return await fn(nodes[0]);
          } finally {
            await Promise.all(nodes.map((n) => n.dispose()));
          }
        };
        return {
          click: () => mutation(() => one(clickElement)),
          setInputFiles: paths => mutation(() => one(n => s.setFiles(tab, n, paths))),
          select: value => mutation(()=>one(n=>feedback("select",n,()=>n.select(value)))),
          fill: (text) =>
            mutation(() =>
              one((n) => feedback("typing",n,async () => {
                await n.focus();
                await n.evaluate((e, v) => {
                  if (!("value" in e)) throw Error("Not a form field");
                  const proto =
                    e instanceof HTMLTextAreaElement
                      ? HTMLTextAreaElement.prototype
                      : HTMLInputElement.prototype;
                  Object.getOwnPropertyDescriptor(proto, "value").set.call(
                    e,
                    v,
                  );
                  e.dispatchEvent(new Event("input", { bubbles: true }));
                  e.dispatchEvent(new Event("change", { bubbles: true }));
                }, String(text));
              })),
            ),
          innerText: () =>
            one((n) => n.evaluate((e) => e.innerText || e.textContent)),
          count: async () => {
            const n = await query();
            await Promise.all(n.map((x) => x.dispose()));
            return n.length;
          },
        };
      };
      return {
        id: tab.id,
        getState: async () => ({
          id: tab.id,
          url: page.url(),
          generation: tab.generation,
          controller: s.controller,
          dom: await s.snapshot(tab),
        }),
        domSnapshot: () => s.snapshot(tab),
        getAXState: ax,
        goto: (url) => mutation(() => s.navigate(tab, url)),
        back: () =>
          mutation(() => page.goBack({ waitUntil: "domcontentloaded" })),
        forward: () =>
          mutation(() => page.goForward({ waitUntil: "domcontentloaded" })),
        reload: () =>
          mutation(() => page.reload({ waitUntil: "domcontentloaded" })),
        close: () => mutation(() => page.close()),
        click: (target) => {
          if(Array.isArray(target)) {
            if(target.length!==2 || !target.every(Number.isFinite))throw Error('Coordinates must be [x, y] with finite numbers');
            const [x,y]=target;
            return mutation(()=>s.feedbackPoint
              ? s.feedbackPoint(tab,{x,y},'click',()=>page.mouse.click(x,y))
              : page.mouse.click(x,y));
          }
          return typeof target === "number"
            ? mutation(() => byNode(target, clickElement))
            : locator("css", target).click();
        },
        setFiles: (target, paths) => typeof target === "number"
          ? mutation(() => byNode(target, n => s.setFiles(tab, n, paths)))
          : locator("css", target).setInputFiles(paths),
        chooseFiles: paths => mutation(() => s.chooseFiles(tab, paths)),
        getDownloads: () => s.downloads(true),
        type: (selector, text) => locator("css", selector).fill(text),
        typeText: (text) => mutation(async () => {
          const focused=await page.$(":focus");
          try{return await feedback("typing",focused,()=>page.keyboard.type(String(text),{delay:12}));}
          finally{await focused?.dispose();}
        }),
        setValue: (id, value) =>
          mutation(() =>
            byNode(id, e => feedback("typing",e,async () => {
              await e.focus();
              await e.evaluate((e, v) => {
                const proto =
                  e.tagName === "TEXTAREA"
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(
                  proto,
                  "value",
                )?.set;
                if (!setter) throw Error("Not an editable text field");
                setter.call(e, v);
                e.dispatchEvent(new Event("input", { bubbles: true }));
                e.dispatchEvent(new Event("change", { bubbles: true }));
              }, String(value));
            })),
          ),
        pressKey: (key) =>
          mutation(() =>
            page.keyboard.press(
              {
                Return: "Enter",
                Up: "ArrowUp",
                Down: "ArrowDown",
                Left: "ArrowLeft",
                Right: "ArrowRight",
              }[key] || key,
            ),
          ),
        scroll: ({ x = 0, y = 0 }) =>
          mutation(() => feedback("scroll",null,async () => {
            for(let i=0;i<8;i++) {
              await page.mouse.wheel({deltaX:x/8,deltaY:y/8});
              await new Promise(resolve=>setTimeout(resolve,25));
            }
          })),
        select: (selector, value) => locator("css",selector).select(value),
        screenshot: async () => ({
          type: "image",
          data: await page.screenshot({ encoding: "base64", type: "png" }),
          mimeType: "image/png",
        }),
        getScreenshot: async () => ({
          type: "image",
          data: await page.screenshot({ encoding: "base64", type: "png" }),
          mimeType: "image/png",
        }),
        handleDialog: (args) => mutation(() => s.handleDialog(tab, args)),
        playwright: {
          locator: (css) => locator("css", css),
          getByRole: (role, o) => locator("role", role, o),
          getByText: (text, o) => locator("text", text, o),
          getByLabel: (text) => locator("label", text),
        },
      };
    };
    const get = (id) => {
      const t = s.tabs.get(String(id));
      if (!t) throw Error("Unknown tab; call cua.getState()");
      return wrap(t);
    };
    const browser = {
      id: "remote-chrome",
      tabs: {
        list: () => s.tabList(),
        get: (id) => get(id),
        new: (url) =>
          mutation(async () => wrap(await s.newTab(url || "about:blank"))),
      },
    };
    ctx.cua = {
      getState: () => s.state(),
      getBrowser: () => browser,
      getTab: (id) => get(id),
      createBrowserTab: (_name, url) => browser.tabs.new(url),
      requestHumanInput: (message) => s.handoff(message),
    };
    ctx.nodeRepl = {
      write,
      emitImage: async (value) => {
        if (value?.type !== "image") throw Error("Expected screenshot image");
        output.push(value);
      },
    };
    ctx.console = { log: (...v) => write(v) };
    const ast = parse(code, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
    });
    const bindings = ast.body.flatMap((n) =>
      n.type === "VariableDeclaration"
        ? n.declarations.flatMap((d) => names(d.id))
        : n.type === "FunctionDeclaration"
          ? [n.id.name]
          : [],
    );
    const script = new vm.Script(
      `(async()=>{${code}\n${bindings.map((n) => `globalThis[${JSON.stringify(n)}]=${n};`).join("\n")} })()`,
    );
    let timer;
    try {
      await this.calls.run(run, () =>
        Promise.race([
          script.runInContext(ctx, { timeout: 1000 }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error("Tool call timed out; inspect browser before retrying"),
                ),
              60000,
            );
          }),
        ]),
      );
      if (!output.length) write(await s.state());
      return output;
    } finally {
      run.active = false;
      clearTimeout(timer);
    }
  }
}
