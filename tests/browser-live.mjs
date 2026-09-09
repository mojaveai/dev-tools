// Opt-in native integration: requires provision.sh --with-browser first.
// Uses synthetic credentials only. Never opens the user's real app/profile.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(repo, 'bin/dev-tools');
const cfg = JSON.parse(fs.readFileSync(process.env.DEVTOOLS_BROWSER_CONFIG || path.join(os.homedir(), '.config/dev-tools/browser.json')));
const { chromium } = await import(pathToFileURL(path.join(cfg.runtime, 'node_modules/playwright/index.mjs')));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-tools-browser-live-'));
const env = { ...process.env, DEVTOOLS_BROWSER_STATE: scratch };
const command = (...args) => JSON.parse(execFileSync(executable, ['browser', ...args, '--json'], { env, encoding: 'utf8', timeout: 60000 }));
const clients = new Set();
let viewerBrowser;
const fixture = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Shared browser acceptance</title>
    <style>body{font:24px sans-serif;padding:50px;min-height:75vh}input,button{font:24px sans-serif}</style>
    <h1>Shared browser acceptance</h1><form><label>Name <input autofocus name="name"></label><button>Sign in</button></form>
    <script>if(document.cookie.includes('test_login=demo'))document.body.innerHTML='<h1>Signed in as demo</h1>';
    else document.querySelector('form').onsubmit=e=>{e.preventDefault();if(document.querySelector('input').value==='demo'){
      document.cookie='test_login=demo; Max-Age=86400; SameSite=Lax; Path=/';document.body.innerHTML='<h1>Signed in as demo</h1>';
    }};document.body.onclick=()=>document.querySelector('input')?.focus();</script>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;

// Tiny test-only stdio JSON-RPC driver. Production uses upstream MCP unchanged.
async function attach(session) {
  const child = spawn(executable, ['browser', 'mcp', session], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0;
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    const wait = pending.get(msg.id);
    if (wait) {
      clearTimeout(wait.timer); pending.delete(msg.id);
      if (msg.error) wait.reject(new Error(JSON.stringify(msg.error)));
      else wait.resolve(msg.result);
    }
  });
  child.on('exit', () => {
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error(stderr)); }
    pending.clear();
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}\n${stderr}`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const client = {
    async call(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    },
    async close() {
      clients.delete(client);
      child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('MCP did not exit after EOF')); }, 8000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
  clients.add(client);
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dev-tools-live-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return client;
}

try {
  const a = command('start', 'live-a');
  const b = command('start', 'live-b');
  assert.ok(a.running && a.cdp_ready && b.running && b.cdp_ready, JSON.stringify({ a, b }));
  assert.notEqual(a.display, b.display);
  assert.notEqual(a.cdp_port, b.cdp_port);
  assert.equal(command('start', 'live-a').processes.browser.pid, a.processes.browser.pid);
  let agent = await attach('live-a');
  await agent.call('browser_navigate', { url });
  assert.match(await agent.call('browser_snapshot'), /Shared browser acceptance/);
  await agent.call('browser_evaluate', { function: "() => document.querySelector('input').focus()" });

  viewerBrowser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const viewer = await viewerBrowser.newPage({ viewport: { width: 1500, height: 1000 } });
  const viewerOrigin = `http://127.0.0.1:${a.viewer_port}`;
  await viewer.goto(`${viewerOrigin}/vnc.html?autoconnect=1&view_only=1&resize=scale`);
  await viewer.waitForFunction(() => document.documentElement.classList.contains('noVNC_connected'));
  await viewer.waitForFunction(() => {
    const canvas = document.querySelector('#noVNC_container canvas');
    return canvas?.width === 1440 && canvas?.height === 900;
  });
  await viewer.locator('#noVNC_transition').waitFor({ state: 'hidden' });
  assert.equal(await viewer.evaluate(async () => (await import('./app/ui.js')).default.rfb.viewOnly), true);
  // Agent handoff enables input without the human finding noVNC settings.
  const request = command('request-input', 'live-a', '--message', 'Complete the test login');
  await viewer.waitForFunction(() => document.querySelector('#devtools-handoff')?.textContent.includes('Your turn'));
  await viewer.waitForFunction(async () => !(await import('./app/ui.js')).default.rfb.viewOnly);
  assert.match(await viewer.locator('#devtools-handoff').innerText(), /Your turn/);
  // Click into the displayed application before typing, just as a person does.
  // DOM focus through CDP alone does not move focus out of Chrome's omnibox.
  const canvas = await viewer.locator('#noVNC_container canvas').boundingBox();
  await viewer.locator('#noVNC_container canvas').click({ position: { x: 200 * canvas.width / 1440, y: 400 * canvas.height / 900 } });
  await viewer.keyboard.type('demo');
  await viewer.keyboard.press('Enter');
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await agent.call('browser_snapshot')).includes('Signed in as demo')) break;
    if (attempt === 19) {
      await viewer.screenshot({ path: path.join(scratch, 'viewer-failure.png') });
      throw new Error('Human input through noVNC did not reach the agent browser: ' + await agent.call('browser_evaluate', { function: "() => ({value: document.querySelector('input')?.value, active: document.activeElement?.tagName, focused: document.hasFocus()})" }) + ' artifacts: ' + scratch);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Reconnecting during handoff keeps the same pending request.
  await viewer.reload();
  await viewer.waitForFunction(() => document.documentElement.classList.contains('noVNC_connected'));
  await viewer.waitForFunction(() => document.querySelector('#devtools-handoff')?.textContent.includes('Your turn'));
  await viewer.waitForFunction(async () => !(await import('./app/ui.js')).default.rfb.viewOnly);
  await viewer.locator('#devtools-handoff button').click();
  await viewer.waitForFunction(async () => (await import('./app/ui.js')).default.rfb.viewOnly);
  assert.equal(command('input-status', 'live-a').status, 'completed');
  assert.equal(command('input-status', 'live-a').id, request.id);
  await viewer.close();
  assert.ok(command('status', 'live-a').running, 'Closing the viewer stopped automation');
  await agent.close();
  assert.equal(command('status', 'live-a').processes.browser.pid, a.processes.browser.pid);
  agent = await attach('live-a');
  assert.match(await agent.call('browser_snapshot'), /Signed in as demo/);

  const other = await attach('live-b');
  await other.call('browser_navigate', { url });
  assert.doesNotMatch(await other.call('browser_snapshot'), /Signed in as demo/);
  await other.close();
  await agent.close();
  command('stop', 'live-a');
  assert.ok(command('status', 'live-b').running, 'Stopping A stopped B');
  command('start', 'live-a');
  agent = await attach('live-a');
  await agent.call('browser_navigate', { url });
  assert.match(await agent.call('browser_snapshot'), /Signed in as demo/, 'Saved login lost on session restart');
  await agent.close();
  const listeners = execFileSync('ss', ['-ltnH'], { encoding: 'utf8' });
  for (const meta of [command('status', 'live-a'), command('status', 'live-b')]) {
    for (const port of [meta.cdp_port, meta.viewer_port, meta.vnc_port]) {
      const entries = listeners.split('\n').filter(line => line.split(/\s+/)[3]?.endsWith(`:${port}`));
      assert.ok(entries.length, `Port ${port} not listening`);
      assert.ok(entries.every(line => /^(127\.0\.0\.1|\[::1\]):/.test(line.split(/\s+/)[3])), `Non-loopback listener on ${port}`);
    }
  }
  console.log(JSON.stringify({ passed: ['two isolated native desktops', 'real MCP navigation', 'noVNC view-only default', 'human login through noVNC', 'automatic input handoff', 'pending handoff survives refresh', 'Done restores view-only', 'viewer disconnect survival', 'MCP reconnect survival', 'persistent login after restart', 'session-scoped cleanup', 'loopback-only listeners'], tailnet_viewer: 'not tested by this local test', state: scratch }, null, 2));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (viewerBrowser) await viewerBrowser.close();
  for (const name of ['live-a', 'live-b']) {
    try { command('stop', name); } catch {}
  }
  fixture.close();
}
