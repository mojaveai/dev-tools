export class ViewerTransfers {
  constructor({context, send, error}) {
    Object.assign(this, {context, send, error});
    this.requests = new Set();
    try { this.dismissed = new Set(JSON.parse(localStorage.getItem('shared-browser-dismissed-downloads') || '[]')); }
    catch { this.dismissed = new Set(); }
    this.downloadHistory = document.createElement('details');
    this.downloadSummary = document.createElement('summary');
    this.downloadSummary.textContent = 'Downloads';
    this.panel = document.createElement('section');
    this.panel.id = 'transfers';
    this.panel.style.cssText = 'margin:8px 12px;font:14px system-ui;display:grid;gap:8px';
    this.chooser = document.createElement('div');
    this.progress = document.createElement('div');
    this.progress.setAttribute('role', 'status');
    this.downloads = document.createElement('div');
    this.downloadHistory.append(this.downloadSummary, this.downloads);
    this.downloadHistory.hidden = true;
    this.panel.append(this.chooser, this.progress, this.downloadHistory);
    document.getElementById('viewport').before(this.panel);
  }
  pick({node, chooser, multiple = false, accept = ''}) {
    const target = {...this.context(), node, chooser};
    if (!target.connected) return this.error('Reconnect before selecting a file');
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = multiple; input.accept = accept;
    input.style.display = 'none'; document.body.append(input);
    const cleanup = () => input.remove();
    input.addEventListener('cancel', () => {
      cleanup();
      if (chooser) this.send({type:'cancelChooser', chooser, tab:target.tab, generation:target.generation});
      this.progress.textContent = 'Selection canceled. Existing files were kept.';
    }, {once:true});
    input.addEventListener('change', () => {
      const files = [...input.files]; cleanup();
      if (files.length) this.upload(files, target);
    }, {once:true});
    // Called synchronously inside a tap/click, preserving iPhone user activation.
    input.click();
  }
  upload(files, target) {
    const current = this.context();
    if (current.client !== target.client || current.tab !== target.tab || current.generation !== target.generation)
      return this.error('The page changed while selecting files. Choose them again.');
    if (files.length > 10 || files.some(f => f.size > 10*1024*1024) || files.reduce((n,f)=>n+f.size,0)>20*1024*1024)
      return this.error('Choose up to 10 files, 10 MB each and 20 MB in total.');
    const data = new FormData();
    for (const file of files) data.append('files', file, file.name);
    const params = new URLSearchParams({client:target.client,tab:target.tab,generation:target.generation});
    if (target.chooser) params.set('chooser', target.chooser); else params.set('node', target.node);
    const request = new XMLHttpRequest();
    this.requests.add(request);
    request.open('POST', '/upload?'+params);
    request.timeout = 120000;
    const status = document.createElement('span');
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel transfer';
    cancel.onclick = () => request.abort();
    this.progress.replaceChildren(status, ' ', cancel);
    const label = files.map(f=>f.name).join(', ');
    status.textContent = 'Uploading '+label+'…';
    request.upload.onprogress = e => {
      status.textContent = e.lengthComputable ? `Uploading ${label} · ${Math.round(e.loaded/e.total*100)}%` : 'Uploading '+label+'…';
    };
    request.onload = () => {
      try {
        const response = JSON.parse(request.responseText);
        if (request.status !== 200) throw Error(response.error || 'Upload failed');
        status.textContent = 'Attached: '+response.files.map(f=>f.name).join(', ');
      } catch (err) { this.error(err.message); status.textContent = 'Files were not confirmed attached.'; }
    };
    const interrupted = () => { status.textContent = 'Transfer interrupted. Check the page before choosing again; it will not retry automatically.'; };
    request.onerror = interrupted; request.onabort = interrupted; request.ontimeout = interrupted;
    request.onloadend = () => { cancel.remove(); this.requests.delete(request); };
    this.error(''); request.send(data);
  }
  disconnect() { for (const request of this.requests) request.abort(); this.chooser.replaceChildren(); }
  update(state) {
    const target = state.choosers?.find(c => c.tab === this.context().tab);
    if (this.chooser.dataset.id !== (target?.id || '')) {
      this.chooser.dataset.id = target?.id || ''; this.chooser.replaceChildren();
      if (target) {
        const choose = document.createElement('button'); choose.textContent = 'Choose files';
        choose.onclick = () => this.pick({chooser:target.id,multiple:target.multiple});
        const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
        cancel.onclick = () => this.send({type:'cancelChooser',chooser:target.id,tab:target.tab,generation:target.generation});
        this.chooser.append('The page is requesting a file. ',choose,' ',cancel);
      }
    }
    this.downloads.replaceChildren();
    const visible = (state.downloads || []).filter(item => !this.dismissed.has(item.id));
    this.downloadHistory.hidden = visible.length === 0;
    this.downloadSummary.textContent = `Downloads (${visible.length})`;
    for (const item of visible) {
      const row = document.createElement('div');
      if (item.status === 'completed' && item.url) {
        const link = document.createElement('a'); link.href = item.url; link.download = item.name;
        link.textContent = 'Save '+item.name+' to this device'; row.append(link);
      } else row.textContent = item.name+' · '+(item.error || item.status);
      const dismiss = document.createElement('button');
      dismiss.textContent = 'Dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss '+item.name);
      dismiss.onclick = () => {
        this.dismissed.add(item.id);
        try { localStorage.setItem('shared-browser-dismissed-downloads', JSON.stringify([...this.dismissed].slice(-200))); } catch {}
        this.update(state);
      };
      row.append(' ', dismiss);
      this.downloads.append(row);
    }
  }
}
