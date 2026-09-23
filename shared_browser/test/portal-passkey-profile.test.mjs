import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {portalProfile,portalHook} from '../portal-passkey-profile.mjs';
import {approvalOriginAllowed} from '../portal-passkey-origin.mjs';
test('canonical and QA bridge namespaces and fixed authority are disjoint',()=>{
 const qa=portalProfile(),dev=portalProfile({PORTAL_PROFILE:'canonical-dev'});
 assert.equal(qa.port,8797);assert.equal(dev.port,8798);
 assert.notEqual(qa.names,dev.names);assert.notEqual(qa.edgeIdentity,dev.edgeIdentity);
 for(const env of [{PORTAL_PROFILE:'other'},{PORTAL_PROFILE:'canonical-dev',PORTAL_ORIGIN:qa.origin},{PORTAL_PROFILE:'canonical-dev',PORTAL_VIEWER_ORIGIN:'https://evil.example'}])assert.throws(()=>portalProfile(env));
 const source=fs.readFileSync(new URL('../portal-passkey-hook.js',import.meta.url),'utf8');
 const canonical=portalHook(source,dev),legacy=portalHook(source,qa);
 assert.ok(canonical.includes(dev.origin));assert.ok(!canonical.includes('__portalPasskey'));
 assert.equal(legacy,source);
 new vm.Script(canonical);
 for(const foreign of [qa.origin,dev.origin+'.evil','https://procbox.agent-trace.ts.net:3582'])assert.equal(approvalOriginAllowed({origin:foreign},dev.origin,'https://procbox.agent-trace.ts.net:8443'),false);
 assert.equal(approvalOriginAllowed({origin:dev.origin,crossOrigin:true,topOrigin:'https://procbox.agent-trace.ts.net:8443'},dev.origin,'https://procbox.agent-trace.ts.net:8443'),true);
});
