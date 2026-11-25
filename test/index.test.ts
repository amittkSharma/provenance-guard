import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../src/index.ts';

test('public API exports exactly the documented values', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'OUTPUT_FORMATS',
    'RULE_IDS',
    'RegistryError',
    'check',
    'createFetchJson',
    'render',
  ]);
});
