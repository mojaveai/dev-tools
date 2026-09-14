import {test} from 'node:test';import assert from 'node:assert/strict';import {compactImages} from '../compact-images.mjs';
test('only images with cached original bytes lose duplicate inline bitmaps',()=>{
 const img=src=>({tagName:'img',attributes:{src,rr_dataURL:'data:image/png;base64,abc'}});
 const event={data:{node:{childNodes:[img('https://site.test/image'),img('blob:private'),img('https://site.test/uncached')]}}};
 compactImages(event,new Set(['https://site.test/image']));
 assert.equal(event.data.node.childNodes[0].attributes.rr_dataURL,undefined);
 assert.ok(event.data.node.childNodes.slice(1).every(n=>n.attributes.rr_dataURL));
});
