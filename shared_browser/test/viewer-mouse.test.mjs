import test from 'node:test';
import assert from 'node:assert/strict';
import {relayMouse} from '../viewer-mouse.js';
test('slow receivers get the latest hover position; presses flush movement in order',()=>{
 globalThis.window=new EventTarget();
 let next=0;const frames=new Map(),sent=[];
 globalThis.requestAnimationFrame=fn=>{frames.set(++next,fn);return next;};
 globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const tick=()=>{const f=[...frames.values()];frames.clear();for(const fn of f)fn();};
 const element=new EventTarget();element.setPointerCapture=()=>{};element.hasPointerCapture=()=>false;
 const relay=relayMouse(element,{enabled:()=>true,context:()=>({tab:'tab',generation:'doc'}),point:e=>({x:e.clientX,y:20}),send:m=>{sent.push(m);return String(sent.length);}});
 const emit=(type,x)=>{const e=new Event(type);Object.assign(e,{pointerType:'mouse',pointerId:1,clientX:x,button:0,detail:1});element.dispatchEvent(e);};
 emit('pointermove',1);tick();
 for(let x=2;x<=20;x++){emit('pointermove',x);tick();}
 assert.equal(sent.length,1);
 relay.acknowledge('1');tick();assert.equal(sent.at(-1).x,20);
 emit('pointermove',21);emit('pointerdown',21);
 assert.deepEqual(sent.slice(-2).map(m=>[m.phase,m.x]),[['move',21],['down',21]]);
 emit('pointermove',22);emit('pointerup',22);
 assert.deepEqual(sent.slice(-2).map(m=>[m.phase,m.x]),[['move',22],['up',22]]);
 assert.equal(relay.consumesClick({detail:1}),true);
 relay.dispose();assert.equal(frames.size,0);
});
