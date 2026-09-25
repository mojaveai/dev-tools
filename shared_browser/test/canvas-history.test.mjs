import {test} from 'node:test';import assert from 'node:assert/strict';
import {compactCanvasHistory} from '../canvas-history.mjs';
const update=(id,value)=>({type:3,data:{source:0,attributes:[{id,attributes:{'data-shared-canvas':value,style:'color:red'}}]}});
test('canvas animation retains latest pixels without consuming the DOM checkpoint budget',()=>{
 const state={},events=[];let budget=0;
 for(let i=0;i<30;i++){const e=update(1,'data:image/png;base64,'+'x'.repeat(600000)+i);budget+=JSON.stringify(e).length-compactCanvasHistory(e,state);events.push(e);}
 assert.ok(budget<10000);assert.ok(JSON.stringify(events).length<610000);
 assert.equal(events[0].data.attributes[0].attributes.style,'color:red');
 assert.ok(events.at(-1).data.attributes[0].attributes['data-shared-canvas'].endsWith('29'));
});
test('full and child snapshots, node removal, and new generations release bitmap references',()=>{
 const state={},full={type:2,data:{node:{id:0,childNodes:[{id:1,attributes:{'data-shared-canvas':'first'}}]}}};
 compactCanvasHistory(full,state);const child={type:3,data:{source:0,adds:[{node:{id:2,attributes:{'data-shared-canvas':'child'}}}]}};
 compactCanvasHistory(child,state);compactCanvasHistory(update(1,'latest'),state);
 assert.equal(full.data.node.childNodes[0].attributes['data-shared-canvas'],undefined);
 assert.equal(child.data.adds[0].node.attributes['data-shared-canvas'],'child');
 compactCanvasHistory({type:3,data:{source:0,removes:[{id:2}]}},state);assert.equal(state.canvasHistory.size,1);
 compactCanvasHistory({type:2,data:{node:{id:3}}},state);assert.equal(state.canvasHistory.size,0);
});
