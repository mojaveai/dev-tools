// Approval opens on the relying party's origin so existing passkeys remain valid.
export class ViewerPasskeys {
  constructor() {
    this.panel = document.createElement('section');
    this.panel.id = 'passkey-requests';
    this.panel.setAttribute('aria-live', 'polite');
    this.panel.style.cssText = 'margin:8px 12px;display:grid;gap:8px';
    const requests=document.getElementById('viewer-requests');
    if(requests)requests.append(this.panel);else document.getElementById('viewport').before(this.panel);
    this.signature = '';
    this.poll();
    this.timer = setInterval(() => this.poll(), 1500);
  }
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const response = await fetch('/passkey-requests', {cache:'no-store'});
      if (!response.ok) throw Error('Request unavailable');
      this.update(await response.json());
    } catch { this.update([]); }
    finally { this.busy = false; }
  }
  update(requests) {
    const current = requests.filter(r => r.expiresAt > Date.now());
    const signature = JSON.stringify(current);
    if (signature === this.signature) return;
    this.signature = signature;
    this.panel.replaceChildren();
    for (const request of current) {
      if(request.type==='extension'){
        // Any HTTPS site: the host's Chrome validated the origin; the site verifies the response.
        if(!/^https:\/\/[^/]+$/.test(request.origin||''))continue;
        const row=document.createElement('div');
        row.style.cssText='padding:12px;border:1px solid #a4c9e9;border-radius:10px;background:#eef7ff;color:#17202a';
        row.textContent='Passkey requested · '+new URL(request.origin).hostname+' · '+request.code+' ';
        const button=document.createElement('button');
        button.dataset.devtoolsAuthCode=request.code;button.dataset.authOrigin=request.origin;
        button.disabled=true;button.textContent='Enable Dev Tools Auth to approve here';
        button.style.cssText='padding:9px 12px;margin-left:8px';
        row.append(button);
        this.panel.append(row);continue;
      }
    }
  }
}
