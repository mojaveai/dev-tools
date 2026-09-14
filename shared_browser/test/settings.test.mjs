import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {browserSettings} from '../settings.mjs';

test('persistent profile selection is shared, re-read, and overridable for diagnostics',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'shared-settings-'));
  try {
    const read=env=>browserSettings({env:env||{},home});
    assert.deepEqual(await read(),{stateDir:path.join(home,'.local/state/dev-tools/shared-browser'),chrome:'',hostService:'dev-tools-shared-chrome.service'});
    const file=path.join(home,'.config/dev-tools/shared-browser.json');await fs.mkdir(path.dirname(file),{recursive:true});
    const selected={stateDir:path.join(home,'tested-profile'),chrome:'/opt/google/chrome/chrome',hostService:'dev-tools-shared-chrome-primary.service'};
    await fs.writeFile(file,JSON.stringify(selected));
    assert.deepEqual(await read(),selected);
    assert.deepEqual(await read({SHARED_BROWSER_STATE:'/tmp/isolated-test'}),{...selected,stateDir:'/tmp/isolated-test'});
    selected.stateDir=path.join(home,'another-profile');await fs.writeFile(file,JSON.stringify(selected));
    assert.deepEqual(await read(),selected,'long-running clients must not cache a stale profile selection');
    for(const invalid of ['{',JSON.stringify({...selected,stateDir:'relative'}),JSON.stringify({...selected,chrome:'/chrome\nEnvironment=bad'}),JSON.stringify({...selected,hostService:'../other.service'})]){
      await fs.writeFile(file,invalid);await assert.rejects(read(),'bad settings must not silently fall back to another profile');
    }
  }finally{await fs.rm(home,{recursive:true,force:true});}
});
