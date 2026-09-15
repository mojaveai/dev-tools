import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalOriginAllowed} from '../portal-passkey-origin.mjs';
const portal='https://procbox.agent-trace.ts.net:23581',viewer='https://procbox.agent-trace.ts.net:8443';
test('inline approval requires the exact signed portal and parent origins',()=>{
  assert.equal(approvalOriginAllowed({origin:portal,crossOrigin:true,topOrigin:viewer},portal,viewer),true);
  for(const topOrigin of [undefined,'null','https://evil.example','https://procbox.agent-trace.ts.net:8444',viewer+'.evil.example'])
    assert.equal(approvalOriginAllowed({origin:portal,crossOrigin:true,topOrigin},portal,viewer),false);
  assert.equal(approvalOriginAllowed({origin:viewer,crossOrigin:true,topOrigin:viewer},portal,viewer),false);
});
test('top-level fallback remains valid and inconsistent client data is rejected',()=>{
  for(const crossOrigin of [undefined,false])assert.equal(approvalOriginAllowed({origin:portal,crossOrigin},portal,viewer),true);
  for(const crossOrigin of [undefined,false,'true'])assert.equal(approvalOriginAllowed({origin:portal,crossOrigin,topOrigin:viewer},portal,viewer),false);
});
