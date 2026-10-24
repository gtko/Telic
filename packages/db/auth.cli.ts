// Used only by `bun run auth:generate` (better-auth CLI), never loaded at runtime. It lists
// the better-auth plugins and user fields of packages/auth/src/index.ts that add tables or
// columns, so the CLI emits the sqlite (D1) schema in src/schema/auth.ts. When a plugin or an
// additional field changes in packages/auth, mirror it here and regenerate.
import { betterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { mcp } from '@better-auth/mcp';
import { passkey } from '@better-auth/passkey';
import { genericOAuth, jwt, magicLink, openAPI, username } from 'better-auth/plugins';

const origin = 'http://localhost:8787';

export const auth = betterAuth({
  baseURL: origin,
  secret: 'generate-only',
  user: {
    additionalFields: {
      role: { type: 'string', required: false, defaultValue: 'user', input: false },
      active: { type: 'boolean', required: false, defaultValue: true, input: false },
    },
  },
  plugins: [
    passkey({ rpID: 'localhost', rpName: 'Telic', origin: [origin] }),
    apiKey({ enableSessionForAPIKeys: true, defaultPrefix: 'itp_' }),
    magicLink({ storeToken: 'hashed', sendMagicLink: async () => {} }),
    username({ minUsernameLength: 3, maxUsernameLength: 30 }),
    genericOAuth({ config: [] }),
    jwt({ disableSettingJwtHeader: true, jwt: { issuer: origin } }),
    mcp({
      resource: origin,
      loginPage: `${origin}/login`,
      consentPage: `${origin}/oauth/consent`,
      grantTypes: ['authorization_code', 'refresh_token'],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: 'infer',
    }),
    openAPI(),
  ],
});
