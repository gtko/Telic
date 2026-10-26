import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSentryDescription } from './sentryDescription';

describe('parseSentryDescription', () => {
  it('reads the level and the Sentry link', () => {
    const description =
      'Culprit: apps/api/src/index.ts\n\nLevel: fatal\n\nSentry: https://sentry.io/organizations/acme/issues/42/';
    assert.deepEqual(parseSentryDescription(description), {
      level: 'fatal',
      sentryUrl: 'https://sentry.io/organizations/acme/issues/42/',
    });
  });

  it('returns nulls when the description carries neither', () => {
    assert.deepEqual(parseSentryDescription('Written by hand'), { level: null, sentryUrl: null });
  });

  it('ignores a link that is not http(s)', () => {
    assert.equal(parseSentryDescription('Sentry: javascript:alert(1)').sentryUrl, null);
  });
});
