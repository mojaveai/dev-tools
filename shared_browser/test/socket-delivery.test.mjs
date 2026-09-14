import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSocketDelivery} from '../socket-delivery.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
test('large snapshots drain in order without reconnecting on their own buffer',async()=>{
 const sent=[],callbacks=[],closed=[];
 const ws={readyState:1,bufferedAmount:10*1024*1024,send(raw,cb){sent.push(raw.length);callbacks.push(cb);},close(...args){closed.push(args);},terminate(){throw Error('unexpected termination');}};
 const deliver=createSocketDelivery();
 deliver(ws,'x'.repeat(9*1024*1024));deliver(ws,'y'.repeat(5*1024*1024));deliver(ws,'ready');
 assert.equal(sent.length,1);assert.deepEqual(closed,[]);
 callbacks.shift()();await tick();callbacks.shift()();await tick();callbacks.shift()();await tick();
 assert.deepEqual(sent,[9*1024*1024,5*1024*1024,5]);assert.deepEqual(closed,[]);
});
test('a stalled viewer has a bounded queue',()=>{
 let closed;const ws={readyState:1,send(){},close(code){closed=code;this.readyState=2;}};
 const deliver=createSocketDelivery({maxQueuedBytes:10});deliver(ws,'123456');deliver(ws,'123456');assert.equal(closed,1013);
});
