/* The generated config contains a disposable relay capability, never a passkey. */
const api = browser;
async function relay(path, body) {
  const response = await fetch(AUTH_CONFIG.relay + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: 'Bearer ' + AUTH_CONFIG.token, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Relay unavailable');
  return data;
}
function sameTab(sender, binding) {
  return binding && sender.frameId === 0 && sender.tab?.id === binding.tabId &&
    new URL(sender.url).origin === binding.request.origin;
}
api.runtime.onMessage.addListener(async (message, sender) => {
  try {
    // Only the extension popup may discover requests or create approval tabs.
    const fromPopup = sender.url === api.runtime.getURL('popup.html');
    const viewerURL = sender.url && new URL(sender.url);
    const fromViewer = sender.frameId === 0 && Number.isInteger(sender.tab?.id) &&
      viewerURL.origin === 'https://procbox.agent-trace.ts.net:8443' && viewerURL.pathname === '/';
    if (message.type === 'list' && fromPopup) return {requests: await relay('/pending')};
    if ((message.type === 'open' && fromPopup) || (message.type === 'viewer-open' && fromViewer)) {
      const matches = (await relay('/pending')).filter(r => fromPopup ? r.id === message.id :
        r.id.slice(0,8).toUpperCase() === message.code && r.origin === message.origin);
      const request = matches.length === 1 && matches[0];
      if (!request) throw Error('Request expired');
      if (request.origin !== AUTH_CONFIG.site) throw Error('This site is not enabled for the paired browser');
      const prior = (await api.storage.local.get('binding')).binding;
      if (prior) {
        await relay('/cancel', {id:prior.request.id}).catch(() => {});
        await api.storage.local.remove('binding');
        await api.tabs.remove(prior.tabId).catch(() => {});
      }
      // Create inactive first. Content-script readiness is retried until bound.
      const tab = await api.tabs.create({url: 'about:blank', active: false});
      await api.storage.local.set({binding: {tabId: tab.id, request, returnTabId:fromViewer?sender.tab.id:null, autoStart:fromViewer}});
      await api.tabs.update(tab.id, {url: request.origin+(request.origin.startsWith('http://localhost:')?'/approval':'/'), active: true});
      return {opened: true};
    }
    const {binding} = await api.storage.local.get('binding');
    if (!sameTab(sender, binding)) return {error: 'No approval assigned to this tab'};
    if (message.type === 'ready') {
      const requests = await relay('/pending');
      if (!requests.some(r => r.id === binding.request.id)) return {error: 'Request ended'};
      return {request: binding.request, autoStart:binding.autoStart};
    }
    if (message.id !== binding.request.id) throw Error('Request mismatch');
    if (message.type === 'complete' || message.type === 'cancel') {
      const result = await relay('/' + message.type, {id: message.id, response: message.response});
      await api.storage.local.remove('binding');
      if (Number.isInteger(binding.returnTabId)) {
        // Only return to the exact viewer tab that initiated this approval.
        const returnTab = await api.tabs.get(binding.returnTabId).catch(() => null);
        if (returnTab?.url && new URL(returnTab.url).origin === 'https://procbox.agent-trace.ts.net:8443') {
          await api.tabs.update(binding.returnTabId, {active:true}).catch(() => {});
          await api.tabs.remove(binding.tabId).catch(() => {});
        }
      }
      return result;
    }
    throw Error('Unknown operation');
  } catch (error) { return {error: error.message}; }
});
api.tabs.onRemoved.addListener(async tabId => {
  const {binding} = await api.storage.local.get('binding');
  if (binding?.tabId === tabId) {
    await relay('/cancel', {id: binding.request.id}).catch(() => {});
    await api.storage.local.remove('binding');
  }
});
