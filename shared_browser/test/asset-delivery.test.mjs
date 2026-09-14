import {test} from 'node:test';import assert from 'node:assert/strict';import {AssetDelivery,rewriteStylesheet} from '../asset-delivery.mjs';
test('image requests wait for source bytes and multiple viewers receive them',async()=>{
 const cache=new Map(),delivery=new AssetDelivery(cache);const first=delivery.get('image'),second=delivery.get('image');assert.equal(delivery.pending.size,1);const resource={bytes:Buffer.from('image')};cache.set('image',resource);delivery.available('image');assert.equal(await first,resource);assert.equal(await second,resource);assert.equal(delivery.pending.size,0);
});
test('disconnected viewers release pending requests',async()=>{
 const delivery=new AssetDelivery(new Map()),controller=new AbortController();const request=delivery.get('image',controller.signal);controller.abort();assert.equal(await request,undefined);assert.equal(delivery.pending.size,0);
});
test('external CSS assets and imports resolve against stylesheet URL',()=>{
 const css=rewriteStylesheet('@import "../base.css";a{background:url(../icons/a.png)}b{mask:url("//cdn.test/icon.svg#x")}c{background:url(data:image/png;base64,abc)}d{mask:url(#local)}','tab','https://site.test/css/main.css');
 assert.ok(css.includes(encodeURIComponent('https://site.test/icons/a.png')));assert.ok(css.includes(encodeURIComponent('https://site.test/base.css')));assert.ok(css.includes(encodeURIComponent('https://cdn.test/icon.svg')+'#x'));assert.ok(css.includes('url("data:image/png;base64,abc")'));assert.ok(css.includes('url("#local")'));
});
