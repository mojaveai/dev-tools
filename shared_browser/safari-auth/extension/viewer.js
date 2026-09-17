// The page never receives the pairing capability, challenge, or credential response.
(() => {
  if (window.top !== window || location.origin !== 'https://procbox.agent-trace.ts.net:8443' || location.pathname !== '/') return;
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
