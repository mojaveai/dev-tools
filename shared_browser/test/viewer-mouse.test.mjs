import test from 'node:test';
import assert from 'node:assert/strict';
import {relayMouse} from '../viewer-mouse.js';
test('movement pipelines across delayed acknowledgements, remains bounded, and flushes before presses',()=>{
 globalThis.window=new EventTarget();
 let next=0;const frames=new Map(),sent=[];
 globalThis.requestAnimationFrame=fn=>{frames.set(++next,fn);return next;};
 globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const tick=()=>{const f=[...frames.values()];frames.clear();for(const fn of f)fn();};
 const element=new EventTarget();element.setPointerCapture=()=>{};element.hasPointerCapture=()=>false;
 const relay=relayMouse(element,{enabled:()=>true,context:()=>({tab:'tab',generation:'doc'}),point:e=>({x:e.clientX,y:20}),send:m=>{sent.push(m);return String(sent.length);}});
 const emit=(type,x)=>{const e=new Event(type);Object.assign(e,{pointerType:'mouse',pointerId:1,clientX:x,button:0,detail:1,pressure:type==='pointerdown'?0.5:0});element.dispatchEvent(e);};
 emit('pointermove',1);tick();
 for(let x=2;x<=20;x++){emit('pointermove',x);tick();}
 assert.deepEqual(sent.map(m=>m.x),Array.from({length:20},(_,i)=>i+1));
 for(let x=21;x<=100;x++){emit('pointermove',x);tick();}
 assert.equal(sent.length,32);
 relay.acknowledge('unknown');tick();assert.equal(sent.length,32);
 relay.acknowledge('1');tick();assert.equal(sent.at(-1).x,100);
 emit('pointermove',101);emit('pointerdown',101);
 assert.deepEqual(sent.slice(-2).map(m=>[m.phase,m.x]),[['move',101],['down',101]]);
 assert.equal(sent.at(-1).pressure,0.5);
 emit('pointermove',102);emit('pointerup',102);
 assert.deepEqual(sent.slice(-2).map(m=>[m.phase,m.x]),[['move',102],['up',102]]);
 assert.equal(sent.at(-1).pressure,0);
 assert.equal(relay.consumesClick({detail:1}),true);
 relay.dispose();assert.equal(frames.size,0);
});
