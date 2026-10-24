import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { assertPublicHttpUrl, isPrivateIp, pinnedFetch, UrlNotAllowedError } from '../index';

// A deployed Worker has no NODE_ENV: the guard must be strict there.
describe('SSRF guard without NODE_ENV', () => {
  const nodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.SSRF_DEV_RELAXED;
    delete process.env.SSRF_ALLOWED_HOSTS;
  });
  afterEach(() => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    delete process.env.SSRF_DEV_RELAXED;
  });

  it.each([
    'http://example.com/',
    'http://localhost/',
    'https://localhost/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
    'https://10.1.2.3/',
    'https://[::ffff:10.0.0.1]/',
    'https://[::ffff:a00:1]/',
    'https://[0:0:0:0:0:ffff:7f00:1]/',
    'https://127.1/',
    'https://0x7f.1/',
    'https://2130706433/',
    'https://[fec0::1]/',
    'https://[64:ff9b::7f00:1]/',
    'https://[fe81::1]/',
  ])('refuses %s', async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toBeInstanceOf(UrlNotAllowedError);
  });

  it('is relaxed only when SSRF_DEV_RELAXED=1', async () => {
    process.env.SSRF_DEV_RELAXED = '1';
    expect((await assertPublicHttpUrl('http://localhost:8787/')).hostname).toBe('localhost');
    process.env.SSRF_DEV_RELAXED = 'true';
    await expect(assertPublicHttpUrl('http://localhost:8787/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
  });

  it('never relaxes under the public-only policy', async () => {
    process.env.SSRF_DEV_RELAXED = '1';
    await expect(
      assertPublicHttpUrl('http://169.254.169.254/', { publicOnly: true }),
    ).rejects.toBeInstanceOf(UrlNotAllowedError);
  });

  it('validates the target of a redirect as a new request', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      process.env.SSRF_DEV_RELAXED = '1';
      const res = await pinnedFetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(302);
      delete process.env.SSRF_DEV_RELAXED;
      await expect(pinnedFetch(res.headers.get('location')!)).rejects.toBeInstanceOf(
        UrlNotAllowedError,
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('isPrivateIp', () => {
  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '0000:0000:0000:0000:0000:ffff:a9fe:a9fe',
    '::127.0.0.1',
    'fe80::1',
    'fe81::1',
    'febf::1',
    'fec0::1',
    'feff::1',
    'fc00::1',
    'fd12::1',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
  ])('treats %s as private', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8', '172.32.0.1'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});
