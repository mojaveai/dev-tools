import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dragMouse} from '../agent-drag.mjs';
test('drag presses, moves with steps, and releases in order',async()=>{
 const calls=[];const mouse=Object.fromEntries(['move','down','up'].map(name=>[name,async(...args)=>calls.push([name,...args])]));
 await dragMouse(mouse,[10,20],[300,200],{steps:12});
 assert.deepEqual(calls,[['move',10,20],['down'],['move',300,200,{steps:12}],['up']]);
 await assert.rejects(dragMouse(mouse,[NaN,2],[3,4]),/finite/);
 assert.equal(calls.length,4);
});
test('failed drag releases the button',async()=>{
 let moves=0,released=false;
 await assert.rejects(dragMouse({move:async()=>{if(moves++)throw Error('closed');},down:async()=>{},up:async()=>{released=true;}},[1,2],[3,4]),/closed/);
 assert.equal(released,true);
});
