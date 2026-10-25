import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isArchivedActivity } from './archivedActivity';

describe('isArchivedActivity', () => {
  it('flags the actions of removed features', () => {
    for (const action of ['delegate', 'agent_started', 'agent_finished']) {
      assert.equal(isArchivedActivity(action), true, action);
    }
  });

  it('leaves other actions alone', () => {
    assert.equal(isArchivedActivity('created'), false);
    assert.equal(isArchivedActivity('unknown_action'), false);
  });
});
