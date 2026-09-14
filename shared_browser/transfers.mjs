import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BATCH_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 10;
export function safeName(name) {
  const value = String(name).split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
  return value && value !== '.' && value !== '..' ? value : 'file';
}
export function validateSizes(files, multiple = true) {
  if (!Array.isArray(files) || files.length > MAX_FILES || (!multiple && files.length > 1))
    throw Error(multiple ? 'Choose at most 10 files' : 'This field accepts one file');
  if (files.some(f => !Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES))
    throw Error('Each file must be 10 MB or smaller');
  if (files.reduce((n, f) => n + f.size, 0) > MAX_BATCH_BYTES)
    throw Error('Choose at most 20 MB in total');
}
export async function remoteFiles(paths) {
  if (typeof paths === 'string') paths = [paths];
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p)))
    throw Error('Use absolute file paths on the remote browser host');
  const files = await Promise.all(paths.map(async p => {
    const stat = await fs.stat(p);
    if (!stat.isFile()) throw Error('Only regular files are supported');
    return { path: p, name: path.basename(p), size: stat.size };
  }));
  validateSizes(files);
  return files;
}
export class UploadStore {
  constructor(root) { this.root = root; this.items = new Map(); this.bytes = 0; }
  async stage(files, tab, generation) {
    validateSizes(files);
    const size = files.reduce((n, f) => n + f.size, 0);
    if (this.bytes + size > 128 * 1024 * 1024) throw Error('Upload storage is full; close an old tab first');
    const id = randomUUID(), dir = path.join(this.root, id);
    const item = { id, dir, tab, generation, size, paths: [] };
    this.items.set(id, item); this.bytes += size;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      for (let i = 0; i < files.length; i++) {
        const sub = path.join(dir, String(i));
        await fs.mkdir(sub, { mode: 0o700 });
        const dest = path.join(sub, safeName(files[i].name));
        await fs.writeFile(dest, Buffer.from(await files[i].arrayBuffer()), { mode: 0o600 });
        item.paths.push(dest);
      }
      return item;
    } catch (error) { await this.remove(id); throw error; }
  }
  async remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id); this.bytes -= item.size;
    await fs.rm(item.dir, { recursive: true, force: true });
  }
  async releaseTab(tab) {
    for (const item of [...this.items.values()]) if (item.tab === tab) await this.remove(item.id);
  }
}
