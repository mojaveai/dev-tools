import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retirePreviousHost} from '../host-migration.mjs';

test('profile migration stops and disables the previous managed browser, preserving other services', () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args.includes('--property=Wants')) return 'network.target dev-tools-shared-chrome.service other-test.service\n';
    if (args.includes('--property=ExecStart')) return 'argv[]=/usr/bin/node /runtime/browser-host.mjs ;';
    return '';
  };
  assert.equal(retirePreviousHost('dev-tools-shared-chrome-primary.service', run), 'dev-tools-shared-chrome.service');
  assert.deepEqual(calls.at(-1), ['disable', '--now', 'dev-tools-shared-chrome.service']);
  assert.equal(calls.length, 3);
});

test('ordinary updates and first installation do not stop a browser', () => {
  for (const dependencies of ['', 'network.target', 'dev-tools-shared-chrome-primary.service']) {
    const calls=[];
    assert.equal(retirePreviousHost('dev-tools-shared-chrome-primary.service', args => { calls.push(args); return dependencies; }), null);
    assert.equal(calls.length, 1);
  }
});

test('ambiguous or unmanaged dependencies fail before stopping anything', () => {
  for (const dependencies of ['dev-tools-shared-chrome.service dev-tools-shared-chrome-other.service', 'dev-tools-shared-chrome.service']) {
    const calls=[];
    assert.throws(() => retirePreviousHost('dev-tools-shared-chrome-primary.service', args => {
      calls.push(args);
      return args.includes('--property=Wants') ? dependencies : 'argv[]=/unrelated/service ;';
    }));
    assert.ok(calls.every(args => args[0] === 'show'));
  }
});
