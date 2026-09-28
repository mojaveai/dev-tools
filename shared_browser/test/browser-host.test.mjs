import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {xauthority,loopbackEndpoint,purgeClearanceCookies} from '../browser-host.mjs';

test('the private X11 authority encodes a display-independent random cookie',()=>{
  const cookie=Buffer.from('0123456789abcdef');const data=xauthority(cookie);
  assert.equal(data.readUInt16BE(0),65535);
  let offset=2;const fields=[];
  while(offset<data.length){const size=data.readUInt16BE(offset);offset+=2;fields.push(data.subarray(offset,offset+size));offset+=size;}
  assert.deepEqual(fields.map(b=>b.toString()),['','','MIT-MAGIC-COOKIE-1',cookie.toString()]);
});

test('browser attachment rejects remote or credentialed debugger endpoints',()=>{
  for(const value of ['https://example.com','http://127.0.0.1.example.com:9222','ws://user:pass@127.0.0.1:9222','file:///tmp/debug','http://0.0.0.0:9222'])
    assert.throws(()=>loopbackEndpoint(value),/loopback/);
  assert.equal(loopbackEndpoint('ws://127.0.0.1:9222/devtools/browser/abc'),'ws://127.0.0.1:9222/devtools/browser/abc');
});

test('startup purges fingerprint-bound Cloudflare clearance cookies but keeps sessions',async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'clearance-'));
  const names=['cf_clearance','__cf_bm','_cfuvid','cf_chl_rc_m','__Host-app_session','cfg','xcf_chl'];
  for(const file of ['Default/Cookies','Profile 1/Network/Cookies']){
    await fs.mkdir(path.dirname(path.join(profile,file)),{recursive:true});
    const db=new DatabaseSync(path.join(profile,file));
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT)');
    for(const name of names)db.prepare('INSERT INTO cookies VALUES (?,?)').run('.console.nebius.com',name);
    db.close();
  }
  assert.equal(await purgeClearanceCookies(profile),8);
  for(const file of ['Default/Cookies','Profile 1/Network/Cookies']){
    const db=new DatabaseSync(path.join(profile,file));
    assert.deepEqual(db.prepare('SELECT name FROM cookies ORDER BY name').all().map(r=>r.name),['__Host-app_session','cfg','xcf_chl']);
    db.close();
  }
  assert.equal(await purgeClearanceCookies(path.join(profile,'missing')),0);
  await fs.rm(profile,{recursive:true});
});
