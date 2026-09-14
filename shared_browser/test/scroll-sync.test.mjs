import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrollSync } from '../scroll-sync.mjs';
test('late network acknowledgements cannot overwrite a newer gesture',()=>{
 const sync=new ScrollSync();const old=sync.update(1,0,100);const latest=sync.update(1,0,350);
 assert.equal(sync.acknowledge(old),false);assert.deepEqual(sync.pending.get(1),latest);
 assert.equal(sync.acknowledge(latest),true);assert.equal(sync.pending.size,0);
});
test('nested scroll targets are independent and reconnect drops pending gestures',()=>{
 const sync=new ScrollSync();const outer=sync.update(1,0,100);const inner=sync.update(2,0,50);
 assert.equal(sync.acknowledge(outer),true);assert.deepEqual(sync.pending.get(2),inner);
 sync.clear();assert.equal(sync.acknowledge(inner),false);
});
