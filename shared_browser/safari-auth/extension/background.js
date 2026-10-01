/* Local passkey approval client for dev-tools shared browsers.
 * A request is trusted only if one of the owner's hosts signed it with the
 * fleet key for the exact viewer origin it came from; a look-alike viewer on
 * the tailnet cannot produce that signature. The key never leaves this
 * extension or those hosts, and no passkey material passes through it. */
const api = globalThis.browser || globalThis.chrome;
const encoder = new TextEncoder();
let fleetKey;
function importKey() {
  const bytes = new Uint8Array(AUTH_CONFIG.fleetKey.match(/../g).map(pair => parseInt(pair, 16)));
  return fleetKey ||= crypto.subtle.importKey('raw', bytes, {name:'HMAC', hash:'SHA-256'}, false, ['sign', 'verify']);
}
const message = (...parts) => encoder.encode(['dev-tools-auth', ...parts].join('\n'));
const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
async function proof(action, id) { return hex(await crypto.subtle.sign('HMAC', await importKey(), message(action, id))); }
async function signedByFleet(payload, sig) {
  if (typeof payload !== 'string' || !/^[a-f0-9]{64}$/.test(sig || '')) return false;
  const bytes = new Uint8Array(sig.match(/../g).map(pair => parseInt(pair, 16)));
  return crypto.subtle.verify('HMAC', await importKey(), bytes, message('request', payload));
}
// Shared viewers are served by Tailscale at https://<host>.ts.net:8443/.
// The name only routes the request; the signature establishes the host.
function viewerOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.port === '8443' && u.hostname.endsWith('.ts.net') && u.pathname === '/' ? u.origin : null;
  } catch { return null; }
}
async function call(viewer, path, body) {
  const response = await fetch(viewer + '/auth-companion' + path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
    headers: {'Content-Type': 'application/json'}, signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Shared browser unavailable');
  return data;
}
async function pending(viewer) {
  const requests = [];
  for (const item of await call(viewer, '/pending')) {
    if (!await signedByFleet(item?.payload, item?.sig)) continue;
    const request = JSON.parse(item.payload);
    if (request.viewer === viewer && Date.now() < request.expiresAt) requests.push(request);
  }
  return requests;
}
// The site's own page may already hold a WebAuthn request (for example passkey
// autofill on load), which makes ours fail with "A request is already pending".
// Approve from a script-free document on the same origin when one exists.
async function approvalURL(origin) {
  for (const path of ['/robots.txt', '/.well-known/dev-tools-auth']) {
    try {
      const response = await fetch(origin + path, {credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(5000)});
      // Empty HTTP errors can become chrome-error:// documents, where extension
      // injection and WebAuthn are unavailable. Downloads, images, and no-content
      // responses also cannot be relied on to create an approval document.
      if (!response.ok || response.status === 204 || response.status === 205 ||
          response.type === 'opaqueredirect' ||
          /attachment/i.test(response.headers.get('content-disposition') || '')) continue;
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type === 'text/plain' ||
          (['text/html', 'application/xhtml+xml'].includes(type) && !/<script\b/i.test(await response.text())))
        return origin + path;
    } catch {}
  }
  return origin + '/';
}
const post = async (viewer, action, id, extra = {}) => call(viewer, '/' + action, {id, proof: await proof(action, id), ...extra});
function sameTab(sender, binding) {
  return binding && sender.frameId === 0 && sender.tab?.id === binding.tabId &&
    new URL(sender.url).origin === binding.request.origin;
}
async function returnToViewer(binding) {
  if (!binding.returnURL || viewerOrigin(binding.returnURL) !== binding.viewer) return;
  const tab = await api.tabs.get(binding.tabId).catch(() => null);
  if (tab?.url && new URL(tab.url).origin === binding.request.origin)
    await api.tabs.update(binding.tabId, {url:binding.returnURL, active:true});
}
async function release(binding) {
  await post(binding.viewer, 'cancel', binding.request.id).catch(() => {});
  await api.storage.local.remove('binding');
}
async function handleMessage(msg, sender) {
  try {
    // Only the extension popup may list requests or open a separate approval tab.
    const fromPopup = sender.url === api.runtime.getURL('popup.html');
    const viewer = sender.frameId === 0 && Number.isInteger(sender.tab?.id) ? viewerOrigin(sender.url) : null;
    if (msg.type === 'list' && fromPopup) {
      const {lastViewer} = await api.storage.local.get('lastViewer');
      const {approvalError} = await api.storage.local.get('approvalError');
      if (approvalError) return {error: approvalError};
      if (!lastViewer) return {requests: [], viewer: null};
      return {requests: await pending(lastViewer), viewer: lastViewer};
    }
    if ((msg.type === 'open' && fromPopup) || (msg.type === 'viewer-open' && viewer)) {
      const source = viewer || (await api.storage.local.get('lastViewer')).lastViewer;
      if (!source) throw Error('Open a shared browser viewer first');
      const matches = (await pending(source)).filter(r => fromPopup ? r.id === msg.id :
        r.id.slice(0, 8).toUpperCase() === msg.code && r.origin === msg.origin);
      const request = matches.length === 1 && matches[0];
      if (!request) throw Error('Request expired or not from one of your hosts');
      const prior = (await api.storage.local.get('binding')).binding;
      if (prior) {
        await release(prior);
        if (prior.returnURL) await returnToViewer(prior).catch(() => {});
        else await api.tabs.remove(prior.tabId).catch(() => {});
      }
      const tab = viewer ? sender.tab : await api.tabs.create({url: 'about:blank', active: false});
      await api.storage.local.remove('approvalError');
      await api.storage.local.set({lastViewer: source, binding: {tabId: tab.id, viewer: source, request,
        returnURL: viewer ? sender.url : null, autoStart: !!viewer}});
      // The approval script is injected once this tab reaches the site's origin.
      await api.tabs.update(tab.id, {url: await approvalURL(request.origin), active: true});
      return {opened: true};
    }
    const {binding} = await api.storage.local.get('binding');
    if (!sameTab(sender, binding)) return {error: 'No approval assigned to this tab'};
    if (msg.type === 'ready') {
      if (!(await pending(binding.viewer)).some(r => r.id === binding.request.id)) return {error: 'Request ended'};
      return {request: binding.request, autoStart: binding.autoStart, returnsToViewer: !!binding.returnURL};
    }
    if (msg.id !== binding.request.id) throw Error('Request mismatch');
    if (msg.type === 'complete' || msg.type === 'cancel') {
      const result = await post(binding.viewer, msg.type, msg.id, msg.type === 'complete' ? {response: msg.response} : {});
      await api.storage.local.remove('binding');
      await returnToViewer(binding).catch(() => {});
      return result;
    }
    throw Error('Unknown operation');
  } catch (error) { return {error: error.message}; }
}
// Chrome versions differ in Promise listener support; keep the response channel open.
if (globalThis.browser) api.runtime.onMessage.addListener(handleMessage);
else api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, error => sendResponse({error: error.message}));
  return true;
});
api.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== 'complete') return;
  const {binding} = await api.storage.local.get('binding');
  if (binding?.tabId !== tabId || !tab.url || new URL(tab.url).origin !== binding.request.origin) return;
  try {
    await api.scripting.executeScript({target: {tabId}, files: ['approval.js']});
  } catch (error) {
    // A probe can differ from a real navigation (cookies, content negotiation,
    // or a race with the server). Retry the site's document once, never a
    // credential submission, instead of leaving the user on an error page.
    const current = (await api.storage.local.get('binding')).binding;
    if (current?.request.id !== binding.request.id || current.tabId !== tabId) return;
    if (!binding.documentFallback && tab.url !== binding.request.origin + '/') {
      await api.storage.local.set({binding: {...binding, documentFallback: true}});
      await api.tabs.update(tabId, {url: binding.request.origin + '/', active: true});
      return;
    }
    await api.storage.local.set({approvalError: 'Could not open passkey approval at ' +
      binding.request.origin + ': ' + error.message});
    await release(binding);
    await returnToViewer(binding).catch(() => {});
  }
});
api.tabs.onRemoved.addListener(async tabId => {
  const {binding} = await api.storage.local.get('binding');
  if (binding?.tabId === tabId) await release(binding);
});
