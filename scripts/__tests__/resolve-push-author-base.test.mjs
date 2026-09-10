// [ASTRA-ORCH]
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePushAuthorBase, resolvePrepushBase } from '../resolve-prepush-base.mjs';

test('checks the actual destination even when canonical upstream and origin differ', () => {
  const calls = [];
  assert.equal(resolvePushAuthorBase('gh-fork', (...args) => {
    calls.push(args);
    return args.at(-1) === 'gh-fork/main' ? 'target-base\n' : 'wrong-base\n';
  }), 'target-base');
  assert.deepEqual(calls, [['merge-base', 'HEAD', 'gh-fork/main']]);
});
test('destination without main falls back to origin', () => {
  assert.equal(resolvePushAuthorBase('review', (...args) => {
    if (args.at(-1) === 'review/main') throw new Error('missing');
    assert.equal(args.at(-1), 'origin/main');
    return 'origin-base\n';
  }), 'origin-base');
});
test('without destination or origin tracking refs uses parent commit', () => {
  assert.equal(resolvePushAuthorBase('review', (...args) => {
    if (args[0] === 'merge-base') throw new Error('missing');
    assert.deepEqual(args, ['rev-parse', 'HEAD~1']);
    return 'parent\n';
  }), 'parent');
});
test('canonical manifest base remains upstream-first', () => {
  assert.equal(resolvePrepushBase((...args) => {
    assert.deepEqual(args, ['merge-base', 'HEAD', 'upstream/main']);
    return 'canonical\n';
  }), 'canonical');
});
