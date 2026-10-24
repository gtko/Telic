import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OWNER_VALUE, chosenRole } from './addMemberRole';

describe('add member role', () => {
  it('falls back to the default role when Owner is no longer on offer', () => {
    assert.equal(chosenRole(OWNER_VALUE, 7, false), '7');
    assert.equal(chosenRole(OWNER_VALUE, 7, true), OWNER_VALUE);
    assert.equal(chosenRole('9', 7, false), '9');
    assert.equal(chosenRole('', 7, true), '7');
  });
});
