import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailBody, type EmailConfig, hasEmailProvider, sendEmail } from '../index';

// Resend is the only provider, so these stub its HTTPS API. Nothing leaves the test.

const enabled: EmailConfig = {
  resend: { enabled: true, apiKey: 're_test_key' },
  from: 'Telic <no-reply@telic.test>',
};
const message = {
  to: 'ada@example.com',
  subject: 'Bienvenue',
  text: 'Salut',
  html: '<p>Salut</p>',
};

function stubResend(respond: () => Response | Promise<Response>) {
  const fake = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond());
  vi.stubGlobal('fetch', fake);
  return fake;
}

function sentBody(fake: ReturnType<typeof stubResend>): Record<string, unknown> {
  const init = fake.mock.calls[0]![1]!;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('sendEmail through Resend', () => {
  const savedFrom = process.env.EMAIL_FROM;
  const savedNotifications = process.env.NOTIFICATIONS_EMAIL_FROM;
  beforeEach(() => {
    delete process.env.EMAIL_FROM;
    delete process.env.NOTIFICATIONS_EMAIL_FROM;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = savedFrom;
    if (savedNotifications === undefined) delete process.env.NOTIFICATIONS_EMAIL_FROM;
    else process.env.NOTIFICATIONS_EMAIL_FROM = savedNotifications;
  });

  it('posts the message to the Resend API with the key and the From address', async () => {
    const fake = stubResend(() => Response.json({ id: 'em_1' }, { status: 200 }));
    expect(await sendEmail(enabled, message)).toEqual({ ok: true });

    expect(fake).toHaveBeenCalledTimes(1);
    const [url, init] = fake.mock.calls[0]!;
    expect(String(url)).toBe('https://api.resend.com/emails');
    expect(init!.method).toBe('POST');
    const headers = new Headers(init!.headers);
    expect(headers.get('authorization')).toBe('Bearer re_test_key');
    expect(headers.get('idempotency-key')).toBeNull();
    expect(sentBody(fake)).toEqual({
      from: 'Telic <no-reply@telic.test>',
      to: ['ada@example.com'],
      subject: 'Bienvenue',
      text: 'Salut',
      html: '<p>Salut</p>',
    });
  });

  it('forwards the idempotency key so a retry cannot send twice', async () => {
    const fake = stubResend(() => Response.json({ id: 'em_1' }, { status: 200 }));
    await sendEmail(enabled, { ...message, idempotencyKey: 'notif-42' });
    expect(new Headers(fake.mock.calls[0]![1]!.headers).get('idempotency-key')).toBe('notif-42');
  });

  it('takes the From address from EMAIL_FROM when the config has none', async () => {
    process.env.EMAIL_FROM = 'env@telic.test';
    const fake = stubResend(() => Response.json({}, { status: 200 }));
    await sendEmail({ ...enabled, from: null }, message);
    expect(sentBody(fake).from).toBe('env@telic.test');
  });

  it('prefers the config From address over EMAIL_FROM', async () => {
    process.env.EMAIL_FROM = 'env@telic.test';
    const fake = stubResend(() => Response.json({}, { status: 200 }));
    await sendEmail(enabled, message);
    expect(sentBody(fake).from).toBe('Telic <no-reply@telic.test>');
  });

  it('refuses without a From address and never calls Resend', async () => {
    const fake = stubResend(() => Response.json({}, { status: 200 }));
    expect(await sendEmail({ ...enabled, from: null }, message)).toEqual({
      ok: false,
      retryable: false,
      error: 'EMAIL_FROM is required for Resend',
    });
    expect(fake).not.toHaveBeenCalled();
  });

  it('refuses a message with no recipient and never calls Resend', async () => {
    const fake = stubResend(() => Response.json({}, { status: 200 }));
    expect(await sendEmail(enabled, { ...message, to: '' })).toEqual({
      ok: false,
      retryable: false,
      error: 'no recipient',
    });
    expect(fake).not.toHaveBeenCalled();
  });

  it('reports no provider when Resend is disabled or has no key', async () => {
    const fake = stubResend(() => Response.json({}, { status: 200 }));
    const disabled = { ...enabled, resend: { enabled: false, apiKey: 're_test_key' } };
    const keyless = { ...enabled, resend: { enabled: true, apiKey: '' } };
    for (const config of [disabled, keyless]) {
      expect(await sendEmail(config, message)).toEqual({
        ok: false,
        retryable: false,
        error: 'no email provider enabled',
      });
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it('marks a rate limit as retryable', async () => {
    stubResend(() => new Response('slow down', { status: 429 }));
    const result = await sendEmail(enabled, message);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('Resend HTTP 429');
  });

  it('marks a server error as retryable', async () => {
    stubResend(() => new Response('boom', { status: 503 }));
    expect((await sendEmail(enabled, message)).retryable).toBe(true);
  });

  it('marks a rejected request as permanent', async () => {
    stubResend(() => Response.json({ message: 'invalid to' }, { status: 422 }));
    const result = await sendEmail(enabled, message);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('Resend HTTP 422');
  });

  it('marks a network failure as retryable', async () => {
    stubResend(() => {
      throw new TypeError('fetch failed');
    });
    expect(await sendEmail(enabled, message)).toEqual({
      ok: false,
      retryable: true,
      error: 'fetch failed',
    });
  });
});

describe('hasEmailProvider', () => {
  it('is true only when Resend is enabled with a key', () => {
    expect(hasEmailProvider(enabled)).toBe(true);
    expect(hasEmailProvider({ resend: { enabled: false, apiKey: 're_x' } })).toBe(false);
    expect(hasEmailProvider({ resend: { enabled: true, apiKey: '' } })).toBe(false);
  });
});

describe('emailBody', () => {
  it('escapes the text and keeps line breaks as <br>', () => {
    const body = emailBody('<b>a</b> & "b"\nligne 2');
    expect(body.html).toBe('<p>&lt;b&gt;a&lt;/b&gt; &amp; &quot;b&quot;<br>ligne 2</p>');
    expect(body.text).toBe('<b>a</b> & "b"\nligne 2');
  });

  it('appends the link to both the text and the html, escaped', () => {
    const body = emailBody('Voir', 'https://telic.test/x?a=1&b=2');
    expect(body.text).toBe('Voir\n\nhttps://telic.test/x?a=1&b=2');
    expect(body.html).toBe(
      '<p>Voir</p><p><a href="https://telic.test/x?a=1&amp;b=2">https://telic.test/x?a=1&amp;b=2</a></p>',
    );
  });
});
