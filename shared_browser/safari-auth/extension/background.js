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
    if (message.type === 'list' && fromPopup) return {requests: await relay('/pending')};
    if (message.type === 'open' && fromPopup) {
      const request = (await relay('/pending')).find(r => r.id === message.id);
      if (!request) throw Error('Request expired');
      if (request.origin !== AUTH_CONFIG.site) throw Error('This site is not enabled for the paired browser');
      const prior = (await api.storage.local.get('binding')).binding;
      if (prior) await api.tabs.remove(prior.tabId).catch(() => {});
      // Create inactive first. Content-script readiness is retried until bound.
      const tab = await api.tabs.create({url: 'about:blank', active: false});
      await api.storage.local.set({binding: {tabId: tab.id, request}});
      await api.tabs.update(tab.id, {url: request.origin+(request.origin.startsWith('http://localhost:')?'/approval':'/'), active: true});
      return {opened: true};
    }
    const {binding} = await api.storage.local.get('binding');
    if (!sameTab(sender, binding)) return {error: 'No approval assigned to this tab'};
    if (message.type === 'ready') {
      const requests = await relay('/pending');
      if (!requests.some(r => r.id === binding.request.id)) return {error: 'Request ended'};
      return {request: binding.request};
    }
    if (message.id !== binding.request.id) throw Error('Request mismatch');
    if (message.type === 'complete' || message.type === 'cancel') {
      const result = await relay('/' + message.type, {id: message.id, response: message.response});
      await api.storage.local.remove('binding');
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
