import test from 'node:test';
import assert from 'node:assert/strict';
import { PasskeyGate } from '../passkey-gate.mjs';
function fixture(){let time=100;const gate=new PasskeyGate({origin:'https://demo.example',credential:{id:'dGVzdA',publicKey:new Uint8Array(),counter:0},persist:async()=>{},now:()=>time,ttl:1000});return {gate,advance:()=>time+=1001};}
test('expired and canceled requests never produce authentication options or sign-in',async()=>{
 const {gate,advance}=fixture();const a=gate.start('a');advance();
 assert.equal(gate.get(a.id).status,'expired');await assert.rejects(()=>gate.authenticationOptions(a.id,'phone'));
 assert.equal(gate.consume(a.id,'a'),false);
 const b=gate.start('b');gate.cancel(b.id);await assert.rejects(()=>gate.authenticationOptions(b.id,'phone'));assert.equal(gate.consume(b.id,'b'),false);
});
test('requests bind to their browser session and approving device; success consumes once',async()=>{
 const {gate}=fixture();const request=gate.start('a');await gate.authenticationOptions(request.id,'phone');
 await assert.rejects(()=>gate.approve(request.id,'other-phone',{id:'dGVzdA'}));
 assert.throws(()=>gate.consume(request.id,'other-session'));
 assert.equal(gate.consume(request.id,'a'),false);
 // Exercise consumption separately from cryptographic verification (covered in live tests).
 gate.get(request.id).status='approved';assert.equal(gate.consume(request.id,'a'),true);assert.equal(gate.consume(request.id,'a'),false);
});
test('new sign-in cancels previous pending request and enrollment cannot replace a key',async()=>{
 const {gate}=fixture();const a=gate.start('session');gate.start('session');assert.equal(gate.get(a.id).status,'canceled');
 await assert.rejects(()=>gate.registrationOptions('phone'));await assert.rejects(()=>gate.register('phone',{}));
});
