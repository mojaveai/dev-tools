import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../extension/viewer.js',import.meta.url),'utf8');
test('viewer bridge requires a real user click and keeps the fleet key out of page messages',async()=>{
  let handler;const messages=[];
  const button={dataset:{devtoolsAuthCode:'12345678',authOrigin:'https://auth.nebius.com'},addEventListener:(_,fn)=>handler=fn};
  const window={};window.top=window;
  vm.runInNewContext(source,{window,location:{protocol:'https:',port:'8443',hostname:'coder-pod.asg.ts.net',pathname:'/'},
    document:{documentElement:{},querySelectorAll:()=>[button]},MutationObserver:class{observe(){}},
    browser:{runtime:{sendMessage:async m=>{messages.push(m);return {opened:true};}}}});
  await handler({isTrusted:false});assert.equal(messages.length,0);
  await handler({isTrusted:true});assert.equal(messages.length,1);
  assert.equal(messages[0].type,'viewer-open');assert.equal(messages[0].code,'12345678');
  assert.deepEqual(Object.keys(messages[0]).sort(),['code','origin','type']);
});

test('viewer bridge stays inert outside shared viewers',()=>{
  for(const location of [{protocol:'https:',port:'443',hostname:'coder-pod.asg.ts.net',pathname:'/'},{protocol:'https:',port:'8443',hostname:'evil.example',pathname:'/'},{protocol:'https:',port:'8443',hostname:'coder-pod.asg.ts.net',pathname:'/x'}]){
    let queried=false;const window={};window.top=window;
    vm.runInNewContext(source,{window,location,document:{documentElement:{},querySelectorAll:()=>{queried=true;return [];}},MutationObserver:class{observe(){}},browser:{runtime:{sendMessage:async()=>({})}}});
    assert.equal(queried,false);
  }
});
