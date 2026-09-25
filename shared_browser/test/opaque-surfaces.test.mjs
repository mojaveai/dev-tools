import test from 'node:test';
import assert from 'node:assert/strict';
import { closedShadowHosts, opaqueSignature } from '../opaque-surfaces.mjs';

test('finds outermost closed shadow hosts without exposing nested contents',()=>{
  const root={children:[
    {backendNodeId:1,shadowRoots:[{shadowRootType:'open',children:[
      {backendNodeId:2,shadowRoots:[{shadowRootType:'closed',children:[
        {backendNodeId:3,shadowRoots:[{shadowRootType:'closed'}]}
      ]}]}
    ]}]},
    {backendNodeId:4,shadowRoots:[{shadowRootType:'closed'}]},
  ]};
  assert.deepEqual(closedShadowHosts(root),[2,4]);
});

test('signature changes when pixels or geometry change',()=>{
  const a=[{id:2,offsetX:0,offsetY:0,width:300,height:65,image:'abc'}];
  assert.equal(opaqueSignature(a),opaqueSignature(structuredClone(a)));
  assert.notEqual(opaqueSignature(a),opaqueSignature([{...a[0],image:'def'}]));
  assert.notEqual(opaqueSignature(a),opaqueSignature([{...a[0],offsetY:1}]));
});
