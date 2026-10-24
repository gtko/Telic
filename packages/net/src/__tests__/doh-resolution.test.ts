import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPublicHttpUrl, UrlNotAllowedError } from '../index';

// The hostname check resolves through DNS-over-HTTPS. These stub the resolver's JSON
// answers, so each rule of the check is exercised without depending on public DNS.
// NODE_ENV is test, so the strict rules apply.

type Answer = { Status: number; Answer?: { type: number; data: string }[] } | 'http-500';

function stubResolver(answers: { A?: Answer; AAAA?: Answer }) {
  const fake = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://cloudflare-dns.com') {
      throw new Error(`unexpected request to ${url.origin}`);
    }
    const type = url.searchParams.get('type') as 'A' | 'AAAA';
    const answer = answers[type];
    if (answer === 'http-500') return new Response('', { status: 500 });
    if (!answer) return Response.json({ Status: 0 });
    return Response.json(answer);
  });
  vi.stubGlobal('fetch', fake);
  return fake;
}

const A_RECORD = 1;
const AAAA_RECORD = 28;

describe('hostname check through DNS-over-HTTPS', () => {
  const saved = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.SSRF_ALLOWED_HOSTS;
  });
  afterEach(() => {
    process.env.NODE_ENV = saved;
    vi.unstubAllGlobals();
  });

  it('admits a host whose addresses are all public', async () => {
    stubResolver({
      A: { Status: 0, Answer: [{ type: A_RECORD, data: '93.184.216.34' }] },
      AAAA: { Status: 0, Answer: [{ type: AAAA_RECORD, data: '2606:2800:220:1::1' }] },
    });
    expect((await assertPublicHttpUrl('https://public.example/')).hostname).toBe('public.example');
  });

  it('refuses when any one A answer is private, even beside a public one', async () => {
    stubResolver({
      A: {
        Status: 0,
        Answer: [
          { type: A_RECORD, data: '93.184.216.34' },
          { type: A_RECORD, data: '10.0.0.5' },
        ],
      },
    });
    await expect(assertPublicHttpUrl('https://mixed.example/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
  });

  it('refuses a host whose only address is a private IPv6 (AAAA)', async () => {
    stubResolver({
      A: { Status: 0 },
      AAAA: { Status: 0, Answer: [{ type: AAAA_RECORD, data: 'fd00::1' }] },
    });
    await expect(assertPublicHttpUrl('https://v6.example/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
  });

  it('ignores answers of another record type', async () => {
    stubResolver({
      A: { Status: 0, Answer: [{ type: 5, data: '10.0.0.5' }] },
      AAAA: { Status: 0, Answer: [{ type: AAAA_RECORD, data: '2606:2800:220:1::1' }] },
    });
    expect((await assertPublicHttpUrl('https://cname.example/')).hostname).toBe('cname.example');
  });

  it('fails closed when one family cannot be resolved, even if the other is public', async () => {
    stubResolver({
      A: { Status: 0, Answer: [{ type: A_RECORD, data: '93.184.216.34' }] },
      AAAA: { Status: 2 },
    });
    await expect(assertPublicHttpUrl('https://half.example/')).rejects.toThrow(
      'url host could not be resolved',
    );
  });

  it('fails closed when the resolver answers with an HTTP error', async () => {
    stubResolver({ A: 'http-500', AAAA: { Status: 0 } });
    await expect(assertPublicHttpUrl('https://down.example/')).rejects.toThrow(
      'url host could not be resolved',
    );
  });

  it('reports a nonexistent name as unresolved', async () => {
    stubResolver({ A: { Status: 3 }, AAAA: { Status: 3 } });
    await expect(assertPublicHttpUrl('https://nowhere.example/')).rejects.toThrow(
      'url host could not be resolved',
    );
  });

  it('reports a name with no address at all as unresolved', async () => {
    stubResolver({ A: { Status: 0 }, AAAA: { Status: 0 } });
    await expect(assertPublicHttpUrl('https://empty.example/')).rejects.toThrow(
      'url host could not be resolved',
    );
  });

  it('asks the resolver for both A and AAAA of the exact hostname', async () => {
    const fake = stubResolver({
      A: { Status: 0, Answer: [{ type: A_RECORD, data: '93.184.216.34' }] },
      AAAA: { Status: 0 },
    });
    await assertPublicHttpUrl('https://query.example/');
    const asked = fake.mock.calls.map(([input]) => new URL(String(input)));
    expect(asked.map((u) => u.searchParams.get('type')).sort()).toEqual(['A', 'AAAA']);
    for (const u of asked) expect(u.searchParams.get('name')).toBe('query.example');
  });

  it('does not query the resolver for an IP literal', async () => {
    const fake = stubResolver({});
    await expect(assertPublicHttpUrl('https://10.1.2.3/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
    expect((await assertPublicHttpUrl('https://93.184.216.34/')).hostname).toBe('93.184.216.34');
    expect(fake).not.toHaveBeenCalled();
  });
});
