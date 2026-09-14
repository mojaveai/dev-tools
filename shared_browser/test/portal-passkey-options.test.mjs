import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneOptions} from '../portal-passkey-options.mjs';
test('phone hints preserve credential IDs and all verification inputs without mutating the request',()=>{
 const input={rpId:'example.test',challenge:'challenge',userVerification:'required',extensions:{uvm:true},hints:['security-key'],allowCredentials:[{type:'public-key',id:'registered-id',transports:['usb']}]};
 const result=phoneOptions(input);
 assert.deepEqual(result,{...input,hints:['client-device'],allowCredentials:[{type:'public-key',id:'registered-id'}]});
 assert.deepEqual(input.allowCredentials[0].transports,['usb']);
 assert.deepEqual(input.hints,['security-key']);
});
