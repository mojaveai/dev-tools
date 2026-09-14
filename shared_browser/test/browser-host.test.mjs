import test from 'node:test';
import assert from 'node:assert/strict';
import {xauthority,loopbackEndpoint} from '../browser-host.mjs';

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
