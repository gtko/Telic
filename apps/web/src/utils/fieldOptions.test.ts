import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SELECTABLE_STATE_TYPES, STATE_TYPES } from './fieldOptions';

describe('SELECTABLE_STATE_TYPES', () => {
  it('leaves triage out and keeps the other state types in order', () => {
    assert.ok(STATE_TYPES.includes('triage'));
    assert.deepEqual(
      SELECTABLE_STATE_TYPES,
      STATE_TYPES.filter((s) => s !== 'triage'),
    );
  });
});
