import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {browserConnection} from '../browser-endpoint.mjs';

test('managed endpoint supersedes stale legacy port and is re-read after Chrome restart',async()=>{
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'browser-endpoint-test-'));
  try {
    await fs.mkdir(path.join(stateDir,'profile'));
    await fs.writeFile(path.join(stateDir,'profile/DevToolsActivePort'),'1234\n/devtools/browser/old');
    assert.deepEqual(await browserConnection({stateDir}),{browserURL:'http://127.0.0.1:1234'});
    for(const port of [4321,4322]){
      const endpoint='ws://127.0.0.1:'+port+'/devtools/browser/current';
      await fs.writeFile(path.join(stateDir,'browser-host.json'),JSON.stringify({browserWSEndpoint:endpoint}));
      assert.deepEqual(await browserConnection({stateDir}),{browserWSEndpoint:endpoint});
    }
    const explicit='ws://127.0.0.1:8765/devtools/browser/explicit';
    assert.deepEqual(await browserConnection({stateDir,endpoint:explicit}),{browserWSEndpoint:explicit});
    for(const value of ['invalid',JSON.stringify({browserWSEndpoint:'ws://example.com:1234/'})]){
      await fs.writeFile(path.join(stateDir,'browser-host.json'),value);
      await assert.rejects(browserConnection({stateDir}));
    }
  } finally {await fs.rm(stateDir,{recursive:true,force:true});}
});
