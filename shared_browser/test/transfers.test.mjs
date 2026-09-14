import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UploadStore, safeName, validateSizes, remoteFiles, MAX_FILE_BYTES } from '../transfers.mjs';

test('upload names cannot escape storage and size/count limits are enforced', () => {
  assert.equal(safeName('../../secret.txt'), 'secret.txt');
  assert.equal(safeName('C:\\folder\\hello\r\n.txt'), 'hello.txt');
  assert.equal(safeName('..'), 'file');
  assert.throws(() => validateSizes([{size:MAX_FILE_BYTES+1}]));
  assert.throws(() => validateSizes([{size:0},{size:0}], false));
  assert.throws(() => validateSizes(Array(11).fill({size:0})));
  assert.throws(() => validateSizes(Array(3).fill({size:MAX_FILE_BYTES})));
  validateSizes([{size:0}], false);
});
test('staged duplicate names retain exact bytes in private separate paths and clean up', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'shared-upload-test-'));
  try {
    const store = new UploadStore(dir);
    const item = await store.stage([new File(['one'],'../../same.txt'),new File(['two'],'same.txt')], 'tab', 'generation');
    assert.notEqual(item.paths[0],item.paths[1]);
    assert.deepEqual(await Promise.all(item.paths.map(p=>fs.readFile(p,'utf8'))),['one','two']);
    assert.equal((await fs.stat(item.paths[0])).mode & 0o777,0o600);
    await assert.rejects(()=>remoteFiles(['relative.txt']));
    await assert.rejects(()=>remoteFiles([dir]));
    await assert.rejects(()=>remoteFiles([path.join(dir,'missing')]));
    assert.equal((await remoteFiles(item.paths)).length,2);
    await store.releaseTab('tab');
    assert.equal(store.bytes,0);
    await assert.rejects(()=>fs.stat(item.dir));
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
