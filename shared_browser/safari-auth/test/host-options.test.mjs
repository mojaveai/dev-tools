import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localOptions} from '../host-options.mjs';
const origin='https://demo.yubico.com';
const options={challenge:'a',rpId:'demo.yubico.com',extensions:{credProps:true,remoteDesktopClientOverride:{origin,sameOriginWithAncestors:true}}};
test('uses Chrome trusted origin and removes only the host override',()=>{const result=localOptions('get',options,origin);assert.deepEqual(result,{challenge:'a',rpId:'demo.yubico.com',extensions:{credProps:true}});assert.ok(options.extensions.remoteDesktopClientOverride);});
test('rejects absent origin, different origin and cross-origin frames',()=>{for(const override of [undefined,{origin:'https://elsewhere.example',sameOriginWithAncestors:true},{origin,sameOriginWithAncestors:false}])assert.throws(()=>localOptions('create',{...options,extensions:{remoteDesktopClientOverride:override}},origin),/Unsupported origin/);});
