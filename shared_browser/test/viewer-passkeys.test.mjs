import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../viewer-passkeys.js',import.meta.url),'utf8');
function element(){return {children:[],dataset:{},style:{},append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];}};}
test('viewer offers extension approvals for both enabled prototype sites and clears expired requests',()=>{
 const context=vm.createContext({URL,document:{createElement:element}});
 vm.runInContext(source.replace('export class ViewerPasskeys','class ViewerPasskeys')+';globalThis.Passkeys=ViewerPasskeys;',context);
 const viewer=Object.create(context.Passkeys.prototype);viewer.panel=element();viewer.signature='';
 const request={type:'extension',origin:'https://demo.yubico.com',code:'12345678',expiresAt:Date.now()+120000};
 viewer.update([request]);
 assert.equal(viewer.panel.children.length,1);
 const button=viewer.panel.children[0].children[0];
 assert.equal(button.dataset.authOrigin,request.origin);
 assert.equal(button.dataset.devtoolsAuthCode,request.code);
 assert.equal(button.disabled,true); // Only the trusted extension enables approval.
 viewer.update([{...request,origin:'https://cryptoagent-1-1.agent-trace.ts.net:3581'}]);
 assert.equal(viewer.panel.children.length,1);
 viewer.update([{...request,origin:'https://demo.yubico.com.evil.example'}]);
 assert.equal(viewer.panel.children.length,0);
 viewer.update([{...request,expiresAt:1}]);assert.equal(viewer.panel.children.length,0);
 viewer.update([]);assert.equal(viewer.panel.children.length,0);
});
