import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const wrapper=new URL('../attach-external-chrome.sh',import.meta.url).pathname;

test('attachment reads the current Chrome endpoint on each start',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shared-attach-'));
  try {
    const portFile=path.join(dir,'DevToolsActivePort');
    const node=path.join(dir,'node');
    fs.writeFileSync(node,'#!/bin/sh\nprintf "%s\\n" "$SHARED_BROWSER_CDP_WS_ENDPOINT"\n');
    fs.chmodSync(node,0o755);
    const run=()=>spawnSync(wrapper,{env:{...process.env,SHARED_BROWSER_CDP_PORT_FILE:portFile,SHARED_BROWSER_NODE:node},encoding:'utf8'});
    fs.writeFileSync(portFile,'9222\n/devtools/browser/first-route\n');
    const first=run();
    assert.equal(first.status,0,first.stderr);
    assert.equal(first.stdout.trim(),'ws://127.0.0.1:9222/devtools/browser/first-route');
    fs.writeFileSync(portFile,'9444\n/devtools/browser/second-route\n');
    assert.equal(run().stdout.trim(),'ws://127.0.0.1:9444/devtools/browser/second-route');
    fs.writeFileSync(portFile,'9444\n/devtools/browser/bad?route\n');
    assert.notEqual(run().status,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
