import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Column } from '@/lib/api/endpoints/columns';
import { SELECTABLE_STATE_TYPES, STATE_TYPES, selectableColumns } from './fieldOptions';

describe('SELECTABLE_STATE_TYPES', () => {
  it('leaves triage out and keeps the other state types in order', () => {
    assert.ok(STATE_TYPES.includes('triage'));
    assert.deepEqual(
      SELECTABLE_STATE_TYPES,
      STATE_TYPES.filter((s) => s !== 'triage'),
    );
  });
});

describe('selectableColumns', () => {
  it('drops the triage column and keeps the order of the others', () => {
    const column = (id: number, stateType: Column['stateType']) => ({ id, stateType }) as Column;
    const columns = [
      column(1, 'triage'),
      column(2, 'backlog'),
      column(3, 'triage'),
      column(4, 'completed'),
    ];
    assert.deepEqual(
      selectableColumns(columns).map((c) => c.id),
      [2, 4],
    );
  });
});
