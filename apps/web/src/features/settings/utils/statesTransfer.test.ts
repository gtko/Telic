import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Column } from '@/lib/api/endpoints/columns';
import { parseStatesText, serializeStates } from './statesTransfer';

const column = (name: string, stateType: Column['stateType']): Column => ({
  id: 1,
  projectId: 1,
  name,
  stateType,
  color: '#000000',
  position: 0,
  wipLimit: null,
  wipMode: 'soft',
  autoAssignUserId: null,
});

describe('states transfer', () => {
  it('does not export the triage column', () => {
    const text = serializeStates([column('Triage', 'triage'), column('Todo', 'unstarted')]);
    assert.deepEqual(
      parseStatesText(text).map((s) => s.name),
      ['Todo'],
    );
  });

  it('skips a triage state on import', () => {
    const text = JSON.stringify({
      ...JSON.parse(serializeStates([column('Todo', 'unstarted')])),
      states: [
        { name: 'Triage', stateType: 'triage', color: '#000000' },
        { name: 'Todo', stateType: 'unstarted', color: '#000000' },
      ],
    });
    assert.deepEqual(
      parseStatesText(text).map((s) => s.name),
      ['Todo'],
    );
  });
});
