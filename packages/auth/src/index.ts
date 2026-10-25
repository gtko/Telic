import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { mcp } from '@better-auth/mcp';
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { jwt, openAPI, magicLink, username, genericOAuth } from 'better-auth/plugins';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { Db } from '@repo/db';
import * as schema from '@repo/db/schema';
import {
  getAuthSettings,
  admittedPastGate,
  registrationEmailAllowed,
  hasPendingInvite,
  hasExpiredInvite,
  getGoogleConfig,
  isGoogleUsable,
  getOidcConfig,
  isOidcUsable,
  isAccountDeactivated,
} from './instance';
import { sendAuthEmail } from './mail';
import { readAuthExtensions } from './extensions';

// The variables the auth instance reads. They are passed in, not read from the process:
// a Worker hands over its own env, a Bun process hands over process.env. Nothing here is
// read at import time, so importing this module never needs the configuration.
export interface AuthEnv {
  APP_URL?: string;
  API_URL?: string;
  BETTER_AUTH_SECRET?: string;
  COOKIE_DOMAIN?: string;
  PASSKEY_RP_ID?: string;
  PASSKEY_RP_NAME?: string;
  CLIENT_IP_HEADER?: string;
  TRUSTED_PROXIES?: string;
}

// Without a secret better-auth falls back to a well-known default, so a session can be forged.
const MIN_SECRET_LENGTH = 32;

// Parent domain for a cross-subdomain session cookie (".example.com" from
// "app.example.com"). Returns undefined for localhost, IPs, or apex domains, where
// no cross-subdomain sharing is needed. Used so the SSR web app on one subdomain can
// read the session cookie set by the api on a sibling subdomain.
function parentDomain(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return undefined;
  }
  if (host === 'localhost' || /^[\d.]+$/.test(host)) return undefined;
  const labels = host.split('.');
  if (labels.length < 3) return undefined;
  return '.' + labels.slice(1).join('.');
}

function safeUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

// Everything derived from the environment, computed from it on every call. Mandatory
// config: cookies, the WebAuthn relying party and the cookie domain are all derived from
// it, so a deploy that misses it fails here instead of running on a localhost default.
interface AuthConfig {
  trustedOrigins: string[];
  apiPublicUrl: string;
  baseURL: string;
  apiHasPath: boolean;
  cookieDomain: string | undefined;
  hostPrefixedCookies: boolean;
  passkeyRpID: string;
  clientIpHeader: string;
  trustedProxies: string[] | undefined;
  mcpOAuth: boolean;
  mcpIssuer: string;
  mcpResource: string;
  oauthErrorURL: string;
  googleRedirectUri: string;
  oidcRedirectUri: string;
}

const SESSION_COOKIES = ['session_token', 'session_data', 'account_data', 'dont_remember'];

// http://localhost and its loopback siblings are the only origins where a Secure cookie is
// not needed; every other origin gets Secure cookies whatever NODE_ENV says.
function isLoopbackUrl(origin: string): boolean {
  const { protocol, hostname } = new URL(origin);
  return (
    protocol === 'http:' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
  );
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function authConfig(env: AuthEnv): AuthConfig {
  // Frontend origins allowed to call the auth handler.
  const trustedOrigins = (env.APP_URL ?? '')
    .split(',')
    .map((origin) => stripTrailingSlashes(origin.trim()))
    .filter(Boolean);
  if (trustedOrigins.length === 0) {
    throw new Error('APP_URL is not set: public origin(s) of the web app.');
  }

  // Public URL of the backend, with the path a subpath proxy adds; the links in auth
  // emails and the OAuth redirect URIs are built from it.
  const apiPublicUrl = stripTrailingSlashes(env.API_URL ?? '');
  if (!apiPublicUrl) {
    throw new Error('API_URL is not set: public URL of the backend.');
  }
  const apiUrl = safeUrl(apiPublicUrl);
  if (!apiUrl) {
    throw new Error(`API_URL is not a valid URL: ${apiPublicUrl}`);
  }

  // parentDomain() would widen the cookie to sibling subdomains even when web and api
  // share a host, where a host-only cookie is enough.
  const sameHost = safeUrl(trustedOrigins[0])?.hostname === safeUrl(env.API_URL)?.hostname;

  // COOKIE_DOMAIN wins (multi-label TLDs, deep subdomains); otherwise host-only when web
  // and api share a host, else the parent domain of the frontend.
  const cookieDomain =
    env.COOKIE_DOMAIN || (sameHost ? undefined : parentDomain(trustedOrigins[0]));

  // WebAuthn relying-party id: the frontend domain the passkey is bound to (no port,
  // no scheme). In prod set PASSKEY_RP_ID to the public frontend hostname.
  const passkeyRpID = env.PASSKEY_RP_ID ?? new URL(trustedOrigins[0]!).hostname;

  // The client IP keys the rate limit. The api runs on Cloudflare Workers, which sets
  // CF-Connecting-IP itself; without an IP the limit would share one bucket per path.
  // CLIENT_IP_HEADER overrides it behind another proxy; TRUSTED_PROXIES lets better-auth
  // read an X-Forwarded-For chain.
  const clientIpHeader = env.CLIENT_IP_HEADER || 'cf-connecting-ip';
  const trustedProxies = env.TRUSTED_PROXIES?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  // A baseURL with a path replaces better-auth's /api/auth basePath and the api's fixed
  // mount stops matching, so it only gets the origin.
  const baseURL = apiUrl.origin;
  const apiHasPath = apiUrl.pathname !== '/';

  // Over HTTPS with a host-only cookie the session cookies carry the __Host- prefix.
  const hostPrefixedCookies = baseURL.startsWith('https://') && !cookieDomain;

  // The MCP authorization server. Its issuer is the public URL of the api, so the access
  // tokens, the authorization responses and the discovery documents name the URL a
  // client reaches, behind a path prefix too.
  const mcpIssuer = apiPublicUrl;
  const mcpResource = `${apiPublicUrl}/mcp`;

  // better-auth accepts a plain-HTTP MCP resource only on a loopback host. Any other
  // instance without HTTPS serves MCP to personal API keys only.
  const mcpOAuth =
    apiUrl.protocol === 'https:' ||
    apiUrl.hostname === 'localhost' ||
    apiUrl.hostname === '[::1]' ||
    apiUrl.hostname.startsWith('127.');

  return {
    trustedOrigins,
    apiPublicUrl,
    baseURL,
    apiHasPath,
    cookieDomain,
    hostPrefixedCookies,
    passkeyRpID,
    clientIpHeader,
    trustedProxies,
    mcpOAuth,
    mcpIssuer,
    mcpResource,
    // An error better-auth cannot hand back to the page that started the flow lands here.
    // Its own /api/auth/error is outside a path prefix and, on the api's own host, sends a
    // production browser to the api's root; /login turns ?error= into a message.
    oauthErrorURL: `${trustedOrigins[0]}/login`,
    // The exact authorized redirect URI to register in the Google Cloud console; god mode
    // shows it for copying.
    googleRedirectUri: `${apiPublicUrl}/api/auth/callback/google`,
    // The redirect URI to register with the identity provider; god mode shows it for
    // copying. better-auth serves the callback at /callback/oidc and the api passes this
    // path on to it, so a provider registered with it keeps working.
    oidcRedirectUri: `${apiPublicUrl}/api/auth/oauth2/callback/${OIDC_PROVIDER_ID}`,
  };
}

// The frontend origins the auth handler accepts, from the environment.
export function trustedOriginsOf(env: AuthEnv): string[] {
  return authConfig(env).trustedOrigins;
}

// The redirect URIs god mode shows for copying (see authConfig).
export function googleRedirectUri(env: AuthEnv): string {
  return authConfig(env).googleRedirectUri;
}

export function oidcRedirectUri(env: AuthEnv): string {
  return authConfig(env).oidcRedirectUri;
}

// The generic OIDC provider. One per instance, so its id is a constant: it is what
// the `account` rows store.
export const OIDC_PROVIDER_ID = 'oidc';

// A better-auth instance is built per request by createAuth(env, db): nothing here holds
// a connection, so every query goes to the database the caller passed in.
export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth['$Infer']['Session'];

// The discovery documents list endpoints built from the origin-only baseURL; behind a
// path prefix they would land on whatever serves the root of the host.
async function withPublicDiscoveryUrls(cfg: AuthConfig, response: Response): Promise<Response> {
  if (!cfg.apiHasPath || !response.ok) return response;
  const authBase = `${cfg.baseURL}/api/auth`;
  const toPublic = (value: unknown) =>
    typeof value === 'string' && value.startsWith(authBase)
      ? cfg.apiPublicUrl + value.slice(cfg.baseURL.length)
      : value;
  const metadata = (await response.json()) as Record<string, unknown>;
  for (const [key, value] of Object.entries(metadata)) {
    metadata[key] = Array.isArray(value) ? value.map(toPublic) : toPublic(value);
  }
  return Response.json(metadata, { status: response.status, headers: response.headers });
}

const notFound = () => new Response(null, { status: 404 });

export async function oauthAuthorizationServerMetadata(
  env: AuthEnv,
  db: Db,
  request: Request,
): Promise<Response> {
  const cfg = authConfig(env);
  if (!cfg.mcpOAuth) return notFound();
  return withPublicDiscoveryUrls(
    cfg,
    await oauthProviderAuthServerMetadata(createAuth(env, db))(request),
  );
}

export async function openIdConfiguration(
  env: AuthEnv,
  db: Db,
  request: Request,
): Promise<Response> {
  const cfg = authConfig(env);
  if (!cfg.mcpOAuth) return notFound();
  return withPublicDiscoveryUrls(
    cfg,
    await oauthProviderOpenIdConfigMetadata(createAuth(env, db))(request),
  );
}

// The mcp plugin serves this document itself, for a request under its own path.
export async function oauthProtectedResourceMetadata(env: AuthEnv, db: Db): Promise<Response> {
  const cfg = authConfig(env);
  if (!cfg.mcpOAuth) return notFound();
  return createAuth(env, db).handler(
    new Request(`${cfg.baseURL}/.well-known/oauth-protected-resource`),
  );
}

// The answer to an MCP request without a usable credential. The challenge names the
// resource metadata, which is where an MCP client starts the OAuth flow.
export function mcpUnauthorized(env: AuthEnv): Response {
  const cfg = authConfig(env);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cfg.mcpOAuth) {
    headers.set(
      'WWW-Authenticate',
      `Bearer resource_metadata="${cfg.apiPublicUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
  }
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }),
    { status: 401, headers },
  );
}

// The account an MCP access token was issued to, or null when the token is not valid
// or the account is deactivated. The tokens are JWTs signed with this instance's keys
// and are checked against them in-process: requireMcpAuth fetches the key set over
// HTTP from the public URL, which a container cannot always reach. A JWT stays valid
// until it expires, so the rest is read on every request, as better-auth's own
// introspection does: a token issued in a session ends with it, and so does every
// token of a deactivated account. A DPoP-bound token is valid only with its proof,
// which this check does not take.
export async function verifyMcpAccessToken(
  env: AuthEnv,
  db: Db,
  token: string,
  auth: Auth = createAuth(env, db),
): Promise<string | null> {
  const cfg = authConfig(env);
  if (!cfg.mcpOAuth) return null;
  let claims: { sub?: string; sid?: unknown; cnf?: unknown; client_id?: unknown };
  try {
    ({ payload: claims } = await jwtVerify(token, createLocalJWKSet(await auth.api.getJwks()), {
      issuer: cfg.mcpIssuer,
      audience: cfg.mcpResource,
    }));
  } catch {
    return null;
  }
  if (claims.cnf || !claims.sub) return null;
  const [account] = await db
    .select({ active: schema.user.active })
    .from(schema.user)
    .where(eq(schema.user.id, claims.sub));
  if (!account || isAccountDeactivated(account)) return null;
  // Disconnecting the application on the account's Security page ends its tokens at once.
  if (typeof claims.client_id !== 'string') return null;
  if (!(await isClientConnected(db, claims.sub, claims.client_id))) return null;
  if (typeof claims.sid === 'string') {
    const [open] = await db
      .select({ n: sql`1` })
      .from(schema.session)
      .where(and(eq(schema.session.id, claims.sid), gt(schema.session.expiresAt, new Date())));
    if (!open) return null;
  }
  return claims.sub;
}

// Connected while the person's consent stands or a refresh token can still mint tokens,
// the same rule the Security page lists applications by.
async function isClientConnected(db: Db, userId: string, clientId: string): Promise<boolean> {
  const [consent] = await db
    .select({ n: sql`1` })
    .from(schema.oauthConsent)
    .where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)))
    .limit(1);
  if (consent) return true;
  const [refresh] = await db
    .select({ n: sql`1` })
    .from(schema.oauthRefreshToken)
    .where(
      and(
        eq(schema.oauthRefreshToken.userId, userId),
        eq(schema.oauthRefreshToken.clientId, clientId),
        isNull(schema.oauthRefreshToken.revoked),
        gt(schema.oauthRefreshToken.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(refresh);
}

// User roles. "god" is the owner of the instance: the very first registered user
// gets it automatically; everyone after is a plain "user". The role is assigned
// server-side (input: false) so a client cannot request it at sign-up.
export const USER_ROLES = ['god', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

type PluginContext = Parameters<NonNullable<BetterAuthPlugin['init']>>[0];
type SocialProvider = PluginContext['socialProviders'][number];

// The two conditions better-auth checks before linking an address to an account that
// already has it are read from different places: `trustedProviders` per request,
// through the resolver below, and `requireLocalEmailVerified` off the options object
// at the moment of the decision. The resolver runs first, in the same request, and
// leaves the setting in the instance's state for the getter to read.
const PROVIDER_RETURN = /\/(callback|acs)\//;

const PASSWORD_PATHS = new Set([
  '/sign-up/email',
  '/sign-in/email',
  '/sign-in/username',
  '/request-password-reset',
  '/reset-password',
  '/sign-in/magic-link',
  '/magic-link/verify',
]);

const REGISTRATION_REFUSALS = {
  REGISTRATION_CLOSED: 'Registration is closed on this instance',
  INVITE_ONLY: 'This instance is invite-only. Ask a project owner to invite this address.',
  INVITE_EXPIRED: 'The invite for this address has expired. Ask for a new one.',
  EMAIL_DOMAIN_NOT_ALLOWED: 'This instance does not admit addresses at this domain',
} as const;

function refuseRegistration(code: keyof typeof REGISTRATION_REFUSALS): never {
  throw new APIError('FORBIDDEN', { code, message: REGISTRATION_REFUSALS[code] });
}

// The registration gate: who may create an account. Both sign-up paths run it — the
// email form checks it up front (below), and the user create hook catches every other
// path, which is what stops a Google, OIDC or magic-link sign-up on a closed or
// invite-only instance. Telling an expired invite apart reveals that the address was
// invited, so it is said only once the address is proven (a provider or a magic link):
// the email form, open to anyone, gets the plain invite-only refusal. Each refusal
// carries a `code`, which is what the provider callback and the magic link turn into the
// ?error= they redirect with; without one the callback would fail the request instead.
async function assertRegistrationAllowed(
  db: Db,
  email: string,
  { addressProven }: { addressProven: boolean },
): Promise<void> {
  const settings = await getAuthSettings(db);
  if (settings.registration === 'closed') refuseRegistration('REGISTRATION_CLOSED');
  if (!(await registrationEmailAllowed(db, email))) refuseRegistration('EMAIL_DOMAIN_NOT_ALLOWED');
  if (settings.registration === 'invite' && !(await hasPendingInvite(db, email))) {
    const expired = addressProven && (await hasExpiredInvite(db, email));
    refuseRegistration(expired ? 'INVITE_EXPIRED' : 'INVITE_ONLY');
  }
}

// True when an account matching the sign-in identifier exists and has not confirmed
// its address. Used to hold back sign-in while the instance requires verification. An
// unknown identifier is not "unverified" — it falls through to better-auth's own
// invalid-credentials answer, so this never reveals whether an account exists.
async function isUnverified(db: Db, where: SQL): Promise<boolean> {
  const rows = await db
    .select({ emailVerified: schema.user.emailVerified })
    .from(schema.user)
    .where(where);
  return rows[0] ? !rows[0].emailVerified : false;
}

// Username rules. The bounds are the plugin's own defaults, repeated here because the
// generator below has to stay inside them.
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;
const SUFFIX_LENGTH = 3;

// Three digits appended to a name that is taken, or too short to stand on its own.
// Drawn from the crypto source: the digits are not a secret, but this function sits
// in the sign-up path, where a predictable generator is worth nobody's argument.
function randomSuffix(): string {
  return String(100 + randomInt(900));
}

// Accounts that need no personal workspace made: they own a workspace. Kept per process, so once an account is known a request costs a lookup here
// and nothing in the database. The entries describe the rows of the database, which is
// the one deployment's D1; forgetPersonalWorkspace drops one when its account stops
// owning a workspace.
const settled = new Set<string>();

// The personal workspace of an account that owns none, named after the person: the
// instance owner's always, anyone else's while personal workspaces are on. Sign-up calls
// it, and apps/api on every request, so an account made before personal workspaces, by
// SCIM, or while they were off gets its own without signing in again. Nothing in the API
// creates a workspace; an edition that lets a person own more mounts a route of its own.
// ponytail: an account with no workspace while they are off reads the setting on each
// request; cache it with the setting if that ever shows.
export async function ensurePersonalWorkspace(
  db: Db,
  account: { id: string; role?: string | null },
): Promise<void> {
  const userId = account.id;
  if (settled.has(userId)) return;
  if (account.role !== 'god' && !(await getAuthSettings(db)).personalWorkspaces) return;
  const [person] = await db
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  if (!person) return;
  const name = (person.name.trim() || person.email.split('@')[0]!).slice(0, 60);
  // One batch, so the workspace and its owner row land together, and only while the account
  // still owns no workspace. Each guard reads the rows the batch
  // writes: D1 runs the statements in order, so when two sign-ins race, the second one
  // finds the first one's owner row, and its insert then matches nothing (changes() is
  // 0 after a statement that wrote no row). This replaces a row lock held over the read.
  // drizzle's batch takes query builders only, so the two statements go to the D1 binding
  // directly: its batch is the same atomic unit.
  const client = db.$client;
  await client.batch([
    client
      .prepare(
        `INSERT INTO workspace (name)
         SELECT ? FROM "user" u
         WHERE u.id = ?
           AND NOT EXISTS (
             SELECT 1 FROM workspace_manager m WHERE m.user_id = u.id AND m.role = 'owner'
           )`,
      )
      .bind(name, userId),
    client
      .prepare(
        `INSERT INTO workspace_manager (workspace_id, user_id, role)
         SELECT last_insert_rowid(), ?, 'owner'
         WHERE changes() > 0`,
      )
      .bind(userId),
  ]);
  settled.add(userId);
}

// After an account stops owning a workspace (it deleted or handed over its own), so the
// next request makes it a fresh one while personal workspaces are on.
export function forgetPersonalWorkspace(userId: string): void {
  settled.delete(userId);
}

// Nobody is asked for a username at sign-up: it is derived from the address — the
// local part, with everything the plugin's validator rejects removed — and the owner
// changes it later in the profile. A name already in use gets a random suffix, and
// the check repeats until the name is free.
export async function generateUsername(db: Db, email: string): Promise<string> {
  const stem =
    email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, '')
      .slice(0, USERNAME_MAX_LENGTH - SUFFIX_LENGTH) || 'user';
  let candidate = stem.length >= USERNAME_MIN_LENGTH ? stem : stem + randomSuffix();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const taken = (await db.$count(schema.user, eq(schema.user.username, candidate))) > 0;
    if (!taken) break;
    candidate = stem + randomSuffix();
  }
  return candidate;
}

// Personal API key lifetime. The plugin's option is typed as milliseconds but the
// handler applies it as seconds (the same unit as the `expiresIn` a client sends),
// so it is held in seconds here. The maximum is in days, as the plugin reads it.
const DAY_SEC = 24 * 60 * 60;
export const API_KEY_DEFAULT_EXPIRES_IN_SEC = 90 * DAY_SEC;
export const API_KEY_MAX_EXPIRES_IN_DAYS = 365;

// The better-auth instance for one request, over the database the caller passes in. Built
// on every call, so nothing in it outlives the request except what the database holds:
// the per-instance state below (the Google and OIDC providers, the verification flags) is
// local to this instance, and a build's extendAuth (./extensions) takes effect as long
// as it runs before the first request.
export function createAuth(env: AuthEnv, db: Db) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET is not set or shorter than ${MIN_SECRET_LENGTH} characters: it signs sessions and tokens.`,
    );
  }
  const cfg = authConfig(env);
  const { trustedOrigins, baseURL, apiPublicUrl, mcpOAuth } = cfg;
  const extensions = readAuthExtensions();

  // State the better-auth options read through getters or hooks, one set per instance.
  const state = {
    // While this is true, sign-up answers without a session and a duplicate address
    // gets the same answer as a new one; sign-in of an unconfirmed account is refused in
    // the hook below before better-auth's own check runs.
    verificationRequired: false,
    // Set by the resolver below, read by the getter on the account-linking option.
    trustProviderEmails: false,
    pluginContext: undefined as PluginContext | undefined,
    oidc: undefined as { settings: string; provider: SocialProvider } | undefined,
  };

  const withPublicOrigin = (url: string): string =>
    url.startsWith(baseURL) ? apiPublicUrl + url.slice(baseURL.length) : url;

  // Google credentials live in the database (god mode), not in env. The provider is built
  // once per instance, but it keeps this options object by reference and reads
  // clientId / clientSecret off it on every call, so refreshing the object per request
  // is what lets the owner change or revoke the credentials without a restart.
  // redirectURI is explicit: the one inferred from the origin-only baseURL lacks the path.
  const googleOptions = { clientId: '', clientSecret: '', redirectURI: cfg.googleRedirectUri };

  // Loads the stored credentials into that object and reports whether Google sign-in
  // can run. A read failure disables the provider rather than failing the request with
  // a stale secret.
  async function refreshGoogleOptions(): Promise<boolean> {
    try {
      const config = await getGoogleConfig(db);
      googleOptions.clientId = config.clientId;
      googleOptions.clientSecret = config.clientSecret;
      return isGoogleUsable(config);
    } catch (error) {
      console.error('[auth] could not read the Google credentials:', error);
      return false;
    }
  }

  // genericOAuth reads the discovery document once, when the plugin starts, and keeps
  // the endpoints it found, while this provider is configured in god mode and changes
  // without a restart. So better-auth holds this proxy, and every read on it goes to a
  // provider genericOAuth built from the stored settings.
  const oidcProvider = new Proxy({ id: OIDC_PROVIDER_ID } as SocialProvider, {
    get: (fallback, key) => Reflect.get(state.oidc?.provider ?? fallback, key),
  });

  // Rebuilds the provider when the stored settings changed and reports whether OIDC
  // sign-in can run. A failed read or discovery disables the provider rather than
  // running the request on stale settings.
  async function refreshOidcProvider(): Promise<boolean> {
    try {
      const config = await getOidcConfig(db);
      if (!isOidcUsable(config)) return false;
      const settings = JSON.stringify(config);
      if (state.oidc?.settings === settings) return true;
      const plugin = genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            discoveryUrl: config.discoveryUrl,
            scopes: config.scopes,
            pkce: config.pkce,
            // redirectURI is explicit for the same reason as in googleOptions.
            redirectURI: cfg.oidcRedirectUri,
            // The `account` rows hold the OIDC subject. genericOAuth reads `id` instead
            // when the discovery document lists no id_token signing algorithms.
            accountSubject: ({ profile }) => String(profile.sub ?? ''),
            // genericOAuth passes email_verified on as sent, and some providers send a
            // string (Amazon Cognito's userinfo does): "false" would count as verified.
            mapProfileToUser: (profile) => {
              const claim: unknown = profile.email_verified;
              return { emailVerified: claim === true || claim === 'true' };
            },
            // Signing out of the app leaves the session at the identity provider alone.
            disableProviderLogout: true,
          },
        ],
      });
      const built = await plugin.init({ ...state.pluginContext!, socialProviders: [] });
      // genericOAuth skips a provider whose discovery failed, and logs why.
      const provider = built?.context?.socialProviders?.[0];
      if (!provider) return false;
      state.oidc = { settings, provider };
      return true;
    } catch (error) {
      console.error('[auth] could not load the OIDC provider:', error);
      return false;
    }
  }

  // The context genericOAuth builds a provider in; kept from the first request, when
  // better-auth hands it to the plugin below.
  const instanceOidc = (): BetterAuthPlugin => ({
    id: 'instance-oidc',
    init: (context) => {
      state.pluginContext = context;
      return { context: { socialProviders: [oidcProvider, ...context.socialProviders] } };
    },
  });

  // The trusted providers for one request. The settings are read where a provider's
  // sign-in comes back — an OAuth callback, or a SAML response posted to `/acs/` — only:
  // the resolver runs on every request to the auth API, and a session check has no linking
  // decision to make.
  async function resolveTrustedProviders(request?: Request): Promise<string[]> {
    if (!request || !PROVIDER_RETURN.test(new URL(request.url).pathname)) return [];
    state.trustProviderEmails = (await getAuthSettings(db)).trustProviderEmails;
    return state.trustProviderEmails ? ['google', OIDC_PROVIDER_ID] : [];
  }

  return betterAuth({
    baseURL,
    secret,
    onAPIError: { errorURL: cfg.oauthErrorURL },

    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
        passkey: schema.passkey,
        apikey: schema.apikey,
        jwks: schema.jwks,
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
        ...extensions.schema,
      },
    }),

    emailAndPassword: {
      enabled: true,
      get requireEmailVerification() {
        return state.verificationRequired;
      },
      autoSignIn: true,
      // A reset is how a stolen password is dealt with, so every session opened with
      // the old one ends with it. The signed-in change-password form sends
      // revokeOtherSessions for the same reason.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendAuthEmail(db, {
          to: user.email,
          subject: 'Reset your password',
          text: 'Use the link below to set a new password. Ignore this email if you did not ask for it.',
          url: withPublicOrigin(url),
        });
      },
    },

    emailVerification: {
      // The mail goes out on every sign-up; sendVerificationEmail below drops it when
      // the instance does not require verification.
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const settings = await getAuthSettings(db);
        if (!settings.requireEmailVerification) return;
        await sendAuthEmail(db, {
          to: user.email,
          subject: 'Confirm your email address',
          text: 'Use the link below to confirm this address and finish signing up.',
          url: withPublicOrigin(url),
        });
      },
    },

    // Google sign-in. The provider is always mounted; whether it may run is decided per
    // request in the hook below, the same way the magic link is handled. The factory
    // runs once per instance and returns the options object described above.
    socialProviders: {
      google: async () => {
        await refreshGoogleOptions();
        return googleOptions;
      },
    },

    // A provider address that already has an account signs into it and gains a linked
    // account row, rather than being refused as a duplicate. By default that happens
    // only when the provider reported the address as verified and the local account
    // confirmed its own — Google always reports a verified address, an OIDC provider
    // need not, and an instance with no mail provider has no confirmed accounts at
    // all. The instance setting drops both conditions; after a successful link
    // better-auth marks the local user confirmed too.
    account: {
      accountLinking: {
        trustedProviders: resolveTrustedProviders,
        get requireLocalEmailVerified() {
          return !state.trustProviderEmails;
        },
      },
      // The id_token is stored unencrypted, so this covers only the access and refresh
      // tokens.
      encryptOAuthTokens: true,
    },

    // Extra column on the user table. Not client-settable (input: false) — the role
    // is decided by the create hook below.
    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'user',
          input: false,
        },
        // Deprovisioning flag, written only over SCIM while it acts on the whole instance.
        // Nullable: read it through isAccountDeactivated, which takes only `false`.
        active: {
          type: 'boolean',
          required: false,
          defaultValue: true,
          input: false,
        },
      },
    },

    // The registration gate and the verification check. Both read instance settings
    // per request, so god mode can change them without a restart.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // A key resolves to its owner's session on every endpoint here, and what such a
        // session sets up outlives the key: a passkey enrolled with it still signs in
        // after the key is deleted and the password reset, and a new key starts a fresh
        // lifetime. A key is for the planner API; the account is managed from a signed-in
        // session. A server-side call carries no request and passes.
        if (ctx.request?.headers.get('x-api-key')) {
          throw new APIError('FORBIDDEN', {
            message: 'An API key cannot manage the account. Sign in to do this.',
          });
        }

        // Read here so the two sign-in endpoints, which also go through the
        // verification gate below, make one query instead of two.
        const passwordSettings = PASSWORD_PATHS.has(ctx.path) ? await getAuthSettings(db) : null;
        if (passwordSettings)
          state.verificationRequired = passwordSettings.requireEmailVerification;
        // The api will not let the switch be turned off while no OAuth provider is
        // configured, so this cannot leave an instance with no way in.
        if (passwordSettings && !passwordSettings.emailPassword) {
          throw new APIError('FORBIDDEN', {
            code: 'PASSWORD_AUTH_DISABLED',
            message: 'Password sign-in is disabled on this instance',
          });
        }

        if (ctx.path === '/sign-up/email') {
          await assertRegistrationAllowed(
            db,
            (ctx.body as { email?: string } | undefined)?.email ?? '',
            {
              addressProven: false,
            },
          );
          return;
        }

        const provider =
          ctx.path === '/sign-in/social' || ctx.path === '/link-social'
            ? (ctx.body as { provider?: string } | undefined)?.provider
            : ctx.path.startsWith('/callback/')
              ? ctx.path.slice('/callback/'.length)
              : undefined;
        // No screen links an OIDC identity to the signed-in account, and better-auth
        // already attaches a sign-in to a matching confirmed address on its own.
        if (ctx.path === '/link-social' && provider === OIDC_PROVIDER_ID) {
          throw new APIError('FORBIDDEN', { message: 'Single sign-on cannot be linked' });
        }

        // Both halves of an OAuth round trip: starting it and coming back from it. This
        // is where the stored settings are loaded into the provider, so a request never
        // runs on a value the owner has since changed. The OIDC refusal carries a code
        // because the callback turns it into the ?error= it redirects with; without one
        // the callback fails the request instead.
        if (provider === OIDC_PROVIDER_ID) {
          if (!(await refreshOidcProvider())) {
            throw new APIError('FORBIDDEN', {
              code: 'OIDC_DISABLED',
              message: 'Single sign-on is disabled on this instance',
            });
          }
          return;
        }
        if (provider === 'google') {
          if (!(await refreshGoogleOptions())) {
            throw new APIError('FORBIDDEN', {
              message: 'Google sign-in is disabled on this instance',
            });
          }
          return;
        }

        // Both password endpoints: the sign-in screen sends the one field it has to
        // /sign-in/email or /sign-in/username depending on what was typed, and the
        // instance gate has to apply either way.
        if (ctx.path === '/sign-in/email' || ctx.path === '/sign-in/username') {
          const settings = passwordSettings ?? (await getAuthSettings(db));
          if (!settings.requireEmailVerification) return;
          const body = ctx.body as { email?: string; username?: string } | undefined;
          const identifier =
            ctx.path === '/sign-in/email'
              ? eq(schema.user.email, (body?.email ?? '').trim().toLowerCase())
              : eq(schema.user.username, (body?.username ?? '').trim().toLowerCase());
          if (await isUnverified(db, identifier)) {
            // The code is better-auth's own for this refusal; the sign-in form tells it
            // apart from the other 403s, such as a deactivated account, by it.
            throw new APIError('FORBIDDEN', {
              code: 'EMAIL_NOT_VERIFIED',
              message: 'Confirm your email address before signing in',
            });
          }
          return;
        }

        // The lifetime of a key is fixed at creation; a longer one is a new key.
        if (ctx.path === '/api-key/update') {
          const body = ctx.body as { expiresIn?: number | null } | undefined;
          if (body && body.expiresIn !== undefined) {
            throw new APIError('FORBIDDEN', {
              message: 'The expiry of an API key cannot be changed. Create a new key instead.',
            });
          }
        }
      }),
    },

    databaseHooks: {
      user: {
        create: {
          // Every account creation passes here, whichever method made it, so this is
          // where the registration gate applies to Google.
          //
          // Assign the role before the row is inserted: first user ever → "god",
          // everyone else → "user".
          before: async (user, ctx) => {
            // The email form is refused up front unless its invite is valid, so a refusal
            // here comes from a provider or a magic link, which prove the address.
            if (!(await admittedPastGate(db, user.email, ctx))) {
              await assertRegistrationAllowed(db, user.email, { addressProven: true });
            }
            const isFirstUser = (await db.$count(schema.user)) === 0;
            const carried = typeof user.username === 'string' ? user.username : null;
            const derived = carried ?? (await generateUsername(db, user.email));
            return {
              data: {
                ...user,
                role: isFirstUser ? 'god' : 'user',
                username: derived,
                displayUsername: user.displayUsername ?? derived,
              },
            };
          },
          after: async (user) => {
            await ensurePersonalWorkspace(db, user);
          },
        },
      },
      session: {
        create: {
          // Every sign-in method ends here, so one check covers password, magic link,
          // passkey, Google and OIDC. Deactivation arrives over SCIM or from god mode;
          // apps/api refuses the sessions that are already open.
          before: async (session) => {
            const [account] = await db
              .select({ active: schema.user.active })
              .from(schema.user)
              .where(eq(schema.user.id, session.userId));
            if (account && isAccountDeactivated(account)) {
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_DEACTIVATED',
                message: 'This account is deactivated',
              });
            }
          },
        },
      },
    },

    plugins: [
      // WebAuthn passkeys, a second sign-in method alongside email + password. A
      // passkey is added to an already signed-in account (passkey.addPasskey) and
      // then used to sign in (signIn.passkey). Adds the `passkey` table.
      passkey({
        rpID: cfg.passkeyRpID,
        rpName: env.PASSKEY_RP_NAME ?? 'Telic',
        // Expected origin(s) of the WebAuthn ceremony — the frontend origins.
        origin: trustedOrigins,
      }),
      // Personal API keys: a signed-in user creates a named key, sees its value once
      // at creation, and can list (value hidden) or delete it. Adds the `apikey` table.
      // enableSessionForAPIKeys makes a request carrying an `x-api-key` header resolve
      // to the key owner's session, so getSession (and every planner guard built on it)
      // accepts API keys without any change in apps/api. Rate limit: 100 requests per
      // second per key (timeWindow is in milliseconds). The ceiling is set for the
      // heaviest legitimate caller rather than a typical one: an integration that sends a
      // burst of requests on its own key.
      apiKey({
        enableSessionForAPIKeys: true,
        // Brand prefix so a leaked key is identifiable by secret scanners and in logs.
        // The trailing underscore separates it from the random part (itp_<64 chars>).
        defaultPrefix: 'itp_',
        // A key is a full-account credential, so one that was forgotten stops working
        // on its own. The caller may pick a shorter or longer life up to the maximum.
        keyExpiration: {
          defaultExpiresIn: API_KEY_DEFAULT_EXPIRES_IN_SEC,
          maxExpiresIn: API_KEY_MAX_EXPIRES_IN_DAYS,
        },
        rateLimit: {
          enabled: true,
          timeWindow: 1000,
          maxRequests: 100,
        },
      }),
      // Sign-in by emailed link, offered alongside the password. Whether it is
      // available is an instance setting, so the plugin is always mounted and the
      // sender refuses when it is off. It reuses the `verification` table — no new
      // table, so `auth:generate` output is unchanged.
      magicLink({
        // Stored plain, an OAuth state also passes as a token (GHSA-965c-763c-88jm).
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          const settings = await getAuthSettings(db);
          if (!settings.magicLink) {
            throw new APIError('FORBIDDEN', {
              message: 'Magic links are disabled on this instance',
            });
          }
          await sendAuthEmail(db, {
            to: email,
            subject: 'Your sign-in link',
            text: 'Use the link below to sign in. It works once and expires shortly.',
            url: withPublicOrigin(url),
          });
        },
      }),
      // The instance's OIDC provider, configured in god mode; see oidcProvider above.
      instanceOidc(),
      // Usernames: a second identifier next to the address, unique across the
      // instance. Adds `username` / `display_username` to the user table and the
      // /sign-in/username endpoint the sign-in screen uses when the visitor typed a
      // name rather than an address. Nobody is asked for one — the create hook above
      // derives it from the address, and the profile page changes it afterwards.
      username({
        minUsernameLength: USERNAME_MIN_LENGTH,
        maxUsernameLength: USERNAME_MAX_LENGTH,
      }),
      // OAuth 2.1 for Streamable HTTP MCP clients, on top of the existing session. Any
      // client registers itself (RFC 7591), as ChatGPT and Claude do. The access tokens
      // are JWTs signed by jwt(); no screen reads a session JWT, so it does not put one
      // on every session response.
      ...(mcpOAuth
        ? [
            jwt({ disableSettingJwtHeader: true, jwt: { issuer: cfg.mcpIssuer } }),
            mcp({
              resource: cfg.mcpResource,
              loginPage: `${trustedOrigins[0]}/login`,
              consentPage: `${trustedOrigins[0]}/oauth/consent`,
              // Every token acts for a person; client_credentials would mint one for none.
              grantTypes: ['authorization_code', 'refresh_token'],
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              // Claude Code and Cursor send no application_type; "web" would refuse them.
              clientRegistrationDefaultApplicationType: 'infer',
            }),
          ]
        : []),
      // OpenAPI reference for the better-auth handler. Serves a Scalar UI at
      // /api/auth/reference and the raw schema at /api/auth/open-api/generate-schema.
      // The schema is built from every active plugin, so the passkey and apiKey
      // endpoints are documented automatically. This is docs-only: it adds no table,
      // so `auth:generate` is not needed. The planner's own OpenAPI docs stay at /docs.
      openAPI(),
      // A build's own (./extensions). Typed as none, so the instance's type stays the core's.
      ...(extensions.plugins as []),
    ],

    // The frontend runs on a different origin (Next :3001) — allow its requests.
    trustedOrigins,

    // The default store is in memory, per isolate, so on Workers no limit would ever
    // add up. better-auth's own stricter limits for sign-in, sign-up, password reset
    // and email verification apply on top of this general one.
    rateLimit: { enabled: true, storage: 'database', window: 10, max: 100 },

    // /is-username-available answers for anyone, and a username is derived from the
    // address, so it would tell a stranger which addresses are registered. Nothing in
    // the app calls it — the profile form learns a name is taken from updateUser's
    // error. jwt()'s /token hands out a JWT of the session, which nothing reads.
    disabledPaths: ['/is-username-available', '/token', ...extensions.disabledPaths],

    advanced: {
      // Share the session cookie across subdomains when COOKIE_DOMAIN is the parent
      // domain (e.g. ".example.com" for app.example.com + api.example.com). Without
      // it the cookie is host-only for the api origin, so the SSR web app on another
      // subdomain cannot read the session. Leave COOKIE_DOMAIN unset on localhost
      // (single host), where "lax" host-only cookies already work across ports.
      ...(cfg.cookieDomain
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: cfg.cookieDomain,
            },
          }
        : {}),
      // For a single site (localhost / one domain) "lax" is enough. Subdomains of one
      // registrable domain are same-site, so "lax" cookies are still sent between them.
      ...(cfg.hostPrefixedCookies
        ? {
            useSecureCookies: false,
            cookiePrefix: '__Secure-better-auth',
            cookies: Object.fromEntries(
              SESSION_COOKIES.map((name) => [
                name,
                { name: `__Host-better-auth.${name}`, attributes: { path: '/', secure: true } },
              ]),
            ),
          }
        : {}),
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: cfg.hostPrefixedCookies || !isLoopbackUrl(baseURL),
      },
      ipAddress: {
        ipAddressHeaders: [cfg.clientIpHeader],
        trustedProxies: cfg.trustedProxies,
      },
    },
  });
}

// A key the apiKey plugin will not accept — expired, revoked or malformed — makes
// it throw out of getSession instead of returning no session, which a caller can
// only report as a 500. Such a request carries no session, so it is answered as
// one, and a key that reached its expiry is refused like any other unauthenticated
// request. A refusal for another reason, a rate-limited key among them, still
// propagates: it is not the same answer.
export async function getSessionFromHeaders(
  auth: Auth,
  headers: Headers,
): Promise<Awaited<ReturnType<Auth['api']['getSession']>>> {
  try {
    return await auth.api.getSession({ headers });
  } catch (error) {
    if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 403)) {
      return null;
    }
    throw error;
  }
}

// Instance-wide authentication settings (registration mode, mail provider, invite
// links). Read here by the sign-up gate and the mail senders; managed over HTTP by
// god mode in apps/api.
export {
  REGISTRATION_MODES,
  getAuthSettings,
  setAuthSettings,
  emailDomainAllowed,
  registrationEmailAllowed,
  setRegistrationEmailPolicy,
  setRegistrationAdmission,
  inviteValidSince,
  getEmailSettings,
  setEmailSettings,
  resolveEmailConfig,
  getGoogleSettings,
  setGoogleSettings,
  getGoogleConfig,
  hasConfiguredGoogle,
  getOidcSettings,
  setOidcSettings,
  getOidcConfig,
  getOidcLabel,
  hasConfiguredOidc,
  getScimSettings,
  setScimSettings,
  rotateScimToken,
  verifyScimToken,
  setWorkspaceScim,
  workspaceScim,
  workspacesWithOwnScim,
  isAccountDeactivated,
  accountsManagedByScim,
} from './instance';
export type {
  RegistrationMode,
  AuthSettings,
  InstanceEmailDto,
  InstanceEmailPatch,
  InstanceGoogleDto,
  InstanceGooglePatch,
  InstanceGoogleConfig,
  InstanceOidcDto,
  InstanceOidcPatch,
  InstanceOidcConfig,
  ScimSettingsDto,
} from './instance';
