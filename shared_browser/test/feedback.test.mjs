import test from 'node:test';
import assert from 'node:assert/strict';
import {ActionFeedback} from '../feedback.mjs';
test('cue precedes action and completion only follows a successful action',async()=>{
 const order=[];const feedback=new ActionFeedback({send:e=>order.push(e.phase),hasViewers:()=>true,delay:async()=>order.push('arriving')});
 assert.equal(await feedback.run({kind:'click'},async()=>{order.push('action');return 7;}),7);
 assert.deepEqual(order,['start','arriving','action','done']);
});
test('failed action never produces success feedback',async()=>{
 const events=[];const feedback=new ActionFeedback({send:e=>events.push(e.phase),hasViewers:()=>true,delay:async()=>{}});
 await assert.rejects(feedback.run({kind:'typing'},async()=>{throw Error('stale');}),/stale/);
 assert.deepEqual(events,['start','failed']);
});
test('disconnected viewers add no visual delay',async()=>{
 const feedback=new ActionFeedback({send:()=>assert.fail(),hasViewers:()=>false,delay:()=>assert.fail()});
 assert.equal(await feedback.run({},async()=>42),42);
});
