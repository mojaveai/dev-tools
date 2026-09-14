import fs from 'node:fs/promises';
import path from 'node:path';
import { safeName, MAX_BATCH_BYTES } from './transfers.mjs';

// Chrome writes GUID-named files. Website-provided names never become paths.
export class Downloads {
  constructor(root, notify) { this.root = root; this.notify = notify; this.items = new Map(); }
  async start(browser) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.cdp = await browser.target().createCDPSession();
    await this.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', downloadPath: this.root, eventsEnabled: true,
    });
    this.cdp.on('Browser.downloadWillBegin', event => {
      const item = { id: event.guid, name: safeName(event.suggestedFilename), status: 'inProgress', bytes: 0 };
      if (this.items.size >= 20) {
        item.status = 'canceled'; item.error = 'Download limit reached for this session';
        this.cdp.send('Browser.cancelDownload', { guid: item.id }).catch(() => {});
        return;
      }
      this.items.set(item.id, item);
      this.notify();
    });
    this.cdp.on('Browser.downloadProgress', event => {
      this.progress(event).catch(error => console.error('download tracking failed', error.message));
    });
  }
  async progress(event) {
    const item = this.items.get(event.guid);
    if (!item) return;
    item.bytes = event.receivedBytes;
    const total = [...this.items.values()].reduce((n, d) => n + d.bytes, 0);
    if (event.receivedBytes > MAX_BATCH_BYTES || event.totalBytes > MAX_BATCH_BYTES || total > 100 * 1024 * 1024) {
      item.error = 'Download exceeds the pilot storage limit';
      await this.cdp.send('Browser.cancelDownload', { guid: item.id }).catch(() => {});
    }
    item.status = item.error ? 'canceled' : event.state;
    if (event.state === 'completed') {
      const file = path.join(this.root, item.id);
      if (item.error) await fs.rm(file, { force: true });
      else {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_BATCH_BYTES) throw Error('Invalid downloaded file');
        await fs.chmod(file, 0o600);
        item.bytes = stat.size;
        item.path = file;
      }
    }
    // The link appears only after Chrome has finished writing the file.
    if (event.state !== 'inProgress') this.notify();
  }
  list(agent = false) {
    return [...this.items.values()].slice(-20).map(({ path: file, ...item }) => ({
      ...item, ...(file ? { url: '/download/' + item.id, ...(agent ? { path: file } : {}) } : {}),
    }));
  }
}
