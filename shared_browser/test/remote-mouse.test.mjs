import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteMouse} from '../remote-mouse.mjs';
const event=(phase,extra={})=>({phase,x:12,y:23,button:0,modifiers:0,generation:'a',...extra});
test('mouse forwarding preserves order, coordinates and held movement',async()=>{
 const sent=[],tab={cdp:{send:async(method,params)=>sent.push(params)}},mouse=new RemoteMouse();
 for(const phase of ['move','down','move','up'])await mouse.dispatch('client',tab,event(phase));
 assert.deepEqual(sent.map(e=>e.type),['mouseMoved','mousePressed','mouseMoved','mouseReleased']);
 assert.deepEqual(sent.map(e=>e.buttons),[0,1,1,0]);assert.ok(sent.every(e=>e.x===12&&e.y===23));
 assert.equal(mouse.held.size,0);
});
test('disconnect and document changes release held buttons without replaying input',async()=>{
 const sent=[],tab={cdp:{send:async(method,params)=>sent.push(params)}},mouse=new RemoteMouse();
 await mouse.dispatch('client',tab,event('down'));
 await mouse.release('client');await mouse.release('client');
 assert.equal(sent.filter(e=>e.type==='mouseReleased').length,1);
 await mouse.dispatch('client',tab,event('down'));
 await mouse.dispatch('client',tab,event('move',{generation:'b'}));
 assert.deepEqual(sent.slice(-2).map(e=>[e.type,e.buttons]),[['mouseReleased',0],['mouseMoved',0]]);
 await assert.rejects(mouse.dispatch('client',tab,event('move',{x:NaN})),/Invalid/);
});
