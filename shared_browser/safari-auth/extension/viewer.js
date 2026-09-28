// The page never receives the fleet key, challenge, or credential response.
// Any shared viewer may ask; the background accepts only fleet-signed requests.
(() => {
  if (window.top !== window || location.protocol !== 'https:' || location.port !== '8443' ||
    !location.hostname.endsWith('.ts.net') || location.pathname !== '/') return;
  function connect() {
    for (const button of document.querySelectorAll('button[data-devtools-auth-code]')) {
      if (button.dataset.authConnected) continue;
      button.dataset.authConnected = 'true';
      button.disabled = false;
      button.textContent = 'Approve with passkey';
      button.addEventListener('click', async event => {
        // Synthetic page events must not open authentication prompts.
        if (!event.isTrusted) return;
        button.disabled = true;
        const response = await (globalThis.browser || globalThis.chrome).runtime.sendMessage({type:'viewer-open',
          code:button.dataset.devtoolsAuthCode, origin:button.dataset.authOrigin}).catch(error => ({error:error.message}));
        if (!response?.opened) {
          button.disabled = false;
          button.textContent = response?.error || 'Extension starting—try again';
        } else button.textContent = 'Approval opened';
      });
    }
  }
  new MutationObserver(connect).observe(document.documentElement, {childList:true,subtree:true});
  connect();
})();
