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
    kind: 'member',
    agentKind: null,
    restrictedToUserId: null,
    respondsToMention: null,
    canReadWorkItems: true,
    ...over,
  };
}

describe('mentionCandidatesFrom', () => {
  it('offers the people that have a handle', () => {
    const offered = mentionCandidatesFrom([
      assignee({ username: 'ana' }),
      assignee({ username: 'bot', kind: 'agent' }),
      assignee({ username: null }),
    ]);

    assert.deepEqual(
      offered.map((c) => c.username),
      ['ana'],
    );
  });
});

// The comment box filters the project's assignees with this, as the editors do.
describe('offersMention', () => {
  it('offers people with a handle only', () => {
    assert.equal(offersMention(assignee({ username: 'ana' })), true);
    assert.equal(offersMention(assignee({ username: 'bot', kind: 'agent' })), false);
    assert.equal(offersMention(assignee({ username: null })), false);
  });
});
