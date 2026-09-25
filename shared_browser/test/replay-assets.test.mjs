import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rewriteAssets} from '../replay-assets.mjs';
const extract=text=>new URL(text.match(/url\("([^" ]+)/)[1],'https://viewer.test').searchParams.get('url');
test('font paths normalize to browser cache keys in snapshots and late CSS',()=>{
 const rule='@font-face {src:url("https://cdn.test/scripts/../fonts/icons.woff2")}';
 for(const event of [{type:2,data:{node:{attributes:{_cssText:rule}}}},{type:3,data:{source:8,adds:[{rule,index:0}]}},{type:3,data:{source:10,buffer:false,fontSource:'url(//cdn.test/fonts/icons.woff2)'}}]){
  const original=structuredClone(event),out=rewriteAssets(event,'tab','https://site.test');
  const text=out.data.node?.attributes._cssText || out.data.adds?.[0].rule || out.data.fontSource;
  assert.equal(extract(text),'https://cdn.test/fonts/icons.woff2');assert.deepEqual(event,original);
 }
});
test('asset fragments survive and replay avoids script prefetch storms',()=>{
 const out=rewriteAssets({type:2,data:{childNodes:[{tagName:'use',attributes:{href:'https://cdn.test/sprite.svg#icon'}},{tagName:'link',attributes:{rel:'modulepreload',href:'https://cdn.test/code.js'}},{tagName:'a',attributes:{href:'https://site.test/page'}}]}},'tab');
 assert.ok(out.data.childNodes[0].attributes.href.endsWith('#icon'));
 assert.equal(out.data.childNodes[1].attributes.href,undefined);
 assert.equal(out.data.childNodes[2].attributes.href,'https://site.test/page');
});
test('legacy doctypes retain source quirks layout through rrweb rebuild',()=>{
 const event={type:2,data:{node:{type:0,compatMode:'BackCompat',childNodes:[{type:1,name:'html',publicId:'-//W3C//DTD HTML 4.01 Transitional//EN'},{type:2,tagName:'html',attributes:{}}]}}};
 const out=rewriteAssets(event,'tab');assert.equal(out.data.node.childNodes[0].type,2);assert.equal(event.data.node.childNodes[0].type,1);
});
test('incremental CSS backgrounds preserve priority and use the asset relay',()=>{
 const event={type:3,data:{source:0,attributes:[{id:5,attributes:{style:{'background-image':['url("https://cdn.test/second.png")','important'],color:false,mask:'url(https://cdn.test/mask.svg)'}}}]}};
 const out=rewriteAssets(event,'tab');const style=out.data.attributes[0].attributes.style;
 assert.equal(extract(style['background-image'][0]),'https://cdn.test/second.png');
 assert.equal(style['background-image'][1],'important');assert.equal(style.color,false);
 assert.equal(extract(style.mask),'https://cdn.test/mask.svg');
 assert.equal(event.data.attributes[0].attributes.style.mask,'url(https://cdn.test/mask.svg)');
});
