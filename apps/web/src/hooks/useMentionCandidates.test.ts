import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Assignee } from '@/lib/api/endpoints/projects';
import { mentionCandidatesFrom, offersMention } from './useMentionCandidates';

function assignee(over: Partial<Assignee>): Assignee {
  return {
    userId: over.username ?? 'u',
    name: over.username ?? 'u',
    email: '',
    username: null,
    image: null,
    canReadWorkItems: true,
    ...over,
  };
}

describe('mentionCandidatesFrom', () => {
  it('offers the people that have a handle', () => {
    const offered = mentionCandidatesFrom([
      assignee({ username: 'ana' }),
      assignee({ username: 'bob' }),
      assignee({ username: null }),
    ]);

    assert.deepEqual(
      offered.map((c) => c.username),
      ['ana', 'bob'],
    );
  });
});

// The comment box filters the project's assignees with this, as the editors do.
describe('offersMention', () => {
  it('offers members with a handle only', () => {
    assert.equal(offersMention(assignee({ username: 'ana' })), true);
    assert.equal(offersMention(assignee({ username: null })), false);
  });
});
