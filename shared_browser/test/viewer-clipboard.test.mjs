import {test} from 'node:test';import assert from 'node:assert/strict';import {copyReplaySelection,replaySelection} from '../viewer-clipboard.js';
const doc=(text='',children=[])=>({getSelection:()=>({toString:()=>text}),querySelectorAll:()=>children.map(contentDocument=>({contentDocument}))});
test('copy bridges nested replay selection to the local clipboard event',()=>{let value,prevented=false;const event={clipboardData:{setData:(type,text)=>{assert.equal(type,'text/plain');value=text;}},preventDefault:()=>prevented=true};assert.equal(copyReplaySelection(event,doc('',[doc('Selected words')]),doc()),true);assert.equal(value,'Selected words');assert.equal(prevented,true);});
test('native fields and local selections retain normal copy behavior',()=>{const event={clipboardData:{setData:()=>assert.fail('must not replace local copy')}};const field={...doc(),activeElement:{matches:()=>true}};assert.equal(copyReplaySelection(event,doc('remote'),field),false);assert.equal(copyReplaySelection(event,doc('remote'),doc('local')),false);assert.equal(replaySelection(doc()),'');});
import {handleReplayCopyKey,settledReplaySelection} from '../viewer-clipboard.js';
test('copy shortcut preserves user activation while selection arrives asynchronously',async()=>{
 let pending,prevented=false,blob;const event={metaKey:true,key:'c',preventDefault:()=>prevented=true};
 const clipboard={write:async items=>{blob=await items[0].data['text/plain'];}};
 const selection=new Promise(resolve=>pending=resolve);
 assert.equal(handleReplayCopyKey(event,doc(),doc(),clipboard,assert.fail,()=>selection,class {constructor(data){this.data=data}}),true);
 assert.equal(prevented,true);pending('late selection');await new Promise(r=>setImmediate(r));assert.equal(await blob.text(),'late selection');
});
test('selection waits for pointer acknowledgement and stable text',async()=>{
 let value='';const acknowledged=new Promise(r=>setTimeout(()=>{value='selected';r(true)},10));
 assert.equal(await settledReplaySelection(()=>value,acknowledged,{timeout:400,interval:10}),'selected');
 await assert.rejects(settledReplaySelection(()=>value,Promise.resolve(false)),/rejected/);
});
