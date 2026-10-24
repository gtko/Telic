// Outbound email transport, shared by the two senders in the app: project
// notifications (credentials per project) and authentication mail (credentials per
// instance). Only the transport lives here. Where the credentials come from, how
// they are stored, and what the message says belong to the caller.
//
// The only provider is Resend, over its HTTPS API: it needs no socket, so it runs on
// Cloudflare Workers as it does on Node.

const HTTP_TIMEOUT_MS = 15_000;

// Legacy stored shape. SMTP has no transport on Workers (no sockets): these types only
// keep configs and DTOs written before the Resend-only switch readable. Nothing sends
// through them.
export type SmtpAuth = 'password' | 'microsoft365';

export interface MicrosoftOAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number | null;
  encryption: 'none' | 'ssl' | 'tls';
  username: string;
  password: string;
  timeout: number | null;
  auth?: SmtpAuth;
  oauth?: MicrosoftOAuthConfig;
}

export interface ResendConfig {
  enabled: boolean;
  apiKey: string;
}

export interface EmailConfig {
  resend: ResendConfig;
  // The From address. Falls back to EMAIL_FROM, then to NOTIFICATIONS_EMAIL_FROM.
  from?: string | null;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
}

export interface SendResult {
  ok: boolean;
  // Only meaningful when ok is false: true for a transient failure worth retrying
  // (network error, timeout, rate limit, server error), false for a permanent one
  // (bad credentials, rejected recipient, misconfiguration).
  retryable?: boolean;
  error?: string;
}

// The From address for outbound email. An explicit config value wins, then the
// EMAIL_FROM env var. Resend has no natural fallback: it needs a verified sender.
function fromAddress(config: EmailConfig): string | null {
  if (config.from && config.from.length > 0) return config.from;
  const env = process.env.EMAIL_FROM ?? process.env.NOTIFICATIONS_EMAIL_FROM;
  if (env && env.length > 0) return env;
  return null;
}

async function sendResend(
  resend: ResendConfig,
  message: EmailMessage,
  from: string,
): Promise<SendResult> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resend.apiKey}`,
        'content-type': 'application/json',
        ...(message.idempotencyKey ? { 'idempotency-key': message.idempotencyKey } : {}),
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      error: `Resend HTTP ${res.status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      error: err instanceof Error ? err.message : 'resend request failed',
    };
  }
}

// True when the config has a usable provider. Callers use it to disable features
// that depend on outbound email instead of queuing mail that cannot be sent.
export function hasEmailProvider(config: EmailConfig): boolean {
  return config.resend.enabled && config.resend.apiKey.length > 0;
}

// Sends one message through Resend.
export async function sendEmail(config: EmailConfig, message: EmailMessage): Promise<SendResult> {
  if (!message.to) return { ok: false, retryable: false, error: 'no recipient' };
  const { resend } = config;
  if (!resend.enabled || resend.apiKey.length === 0) {
    return { ok: false, retryable: false, error: 'no email provider enabled' };
  }
  const from = fromAddress(config);
  if (!from) return { ok: false, retryable: false, error: 'EMAIL_FROM is required for Resend' };
  return sendResend(resend, message, from);
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Wraps a plain-text body (and an optional link) into the text/html pair the
// transport needs. Shared so every message in the app looks the same.
export function emailBody(text: string, url?: string | null): { text: string; html: string } {
  const plain = url ? `${text}\n\n${url}` : text;
  const body = escape(text).replace(/\n/g, '<br>');
  const link = url ? `<p><a href="${escape(url)}">${escape(url)}</a></p>` : '';
  return { text: plain, html: `<p>${body}</p>${link}` };
}
