import { t } from 'elysia';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { isAccountDeactivated, type Auth, mcpUnauthorized, verifyMcpAccessToken } from '@repo/auth';
import type { Db } from '@repo/db';
import type { Env } from '../env';
import { buildMcpServer } from './server';
import type { McpApp } from './types';
import type { McpCredential } from './credential';

const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

// The API key on the request. MCP clients send Authorization: Bearer <key>;
// x-api-key is also accepted (the REST convention). Returns null when absent.
function extractApiKey(request: Request): string | null {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer ?? request.headers.get('x-api-key') ?? null;
}

// Answers without building a server what the SDK transport would reject with an opaque 400.
// A client speaking a newer protocol revision opens with `server/discover` and an unsupported
// `mcp-protocol-version`; a JSON-RPC "method not found" sends it back to `initialize` at once.
export function unsupportedRequest(request: Request, body: unknown): Response | null {
  const message = (Array.isArray(body) ? body[0] : body) as
    { id?: unknown; method?: unknown } | null | undefined;
  const id = message?.id ?? null;
  const supported = [...SUPPORTED_PROTOCOL_VERSIONS];
  if (message?.method === 'server/discover') {
    return Response.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found: server/discover', data: { supported } },
    });
  }
  const version = request.headers.get('mcp-protocol-version');
  if (message?.method !== 'initialize' && version && !supported.includes(version)) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: `Bad Request: Unsupported protocol version: ${version} (supported versions: ${supported.join(', ')})`,
          data: { supported },
        },
      },
      { status: 400 },
    );
  }
  return null;
}

// Adds the MCP endpoint (/mcp) to the app. Mounted on
// the root app, outside the planner session guard, because the MCP handshake is not
// a planner route: auth is resolved here and the key is forwarded to the loopback
// requests the tools make. `app` is captured so the tool generator can read
// app.routes and each tool call can dispatch through app.handle.
//
// Stateless transport (sessionIdGenerator undefined): a fresh server and transport
// per request. Personal API keys remain supported for existing integrations; native
// OAuth is the default route for clients that discover this resource, such as ChatGPT.
// Typed as `any` because it is the composition root: it needs Elysia's route methods to
// register the routes, and Elysia's generics are invariant, so a precise parameter
// type would reject the concrete app. The captured `app` is passed on as McpApp.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountMcp(app: any): void {
  const mcpApp = app as McpApp;
  app.post(
    '/mcp',
    async ({
      request,
      body,
      db,
      env,
      auth,
    }: {
      request: Request;
      body: unknown;
      db: Db;
      env: Env;
      auth: Auth;
    }) => {
      const serve = async (credential: McpCredential, userId: string) => {
        const rejected = unsupportedRequest(request, body);
        if (rejected) return rejected;
        const server = await buildMcpServer(db, mcpApp, credential, userId);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        // Pass the body Elysia already parsed so the request stream is not read twice.
        return transport.handleRequest(request, { parsedBody: body });
      };

      const apiKey = extractApiKey(request);
      // An OAuth access token is a JWT and an API key is not: try the token first so the
      // common OAuth call does not pay for an API key lookup that cannot match.
      if (apiKey && JWT_SHAPE.test(apiKey)) {
        const userId = await verifyMcpAccessToken(env, db, apiKey, auth);
        if (userId) return serve({ kind: 'oauth', accessToken: apiKey }, userId);
      }
      if (apiKey) {
        const headers = new Headers(request.headers);
        headers.set('x-api-key', apiKey);
        try {
          const session = await auth.api.getSession({ headers });
          // A deactivated account is refused here too, the way shared/auth-context.ts
          // refuses it for every planner route. Deactivation arrives over SCIM or from
          // god mode, after the key was issued.
          if (session && !isAccountDeactivated(session.user))
            return serve({ kind: 'api-key', apiKey }, session.user.id);
        } catch {
          // Not an API key: it may be an OAuth access token, checked below.
        }
      }
      const userId = apiKey ? await verifyMcpAccessToken(env, db, apiKey, auth) : null;
      if (apiKey && userId) return serve({ kind: 'oauth', accessToken: apiKey }, userId);
      return mcpUnauthorized(env);
    },
    {
      body: t.Any(),
      // Kept out of the REST OpenAPI docs: this is a JSON-RPC endpoint, not a REST route.
      detail: { summary: 'MCP Streamable HTTP endpoint', hide: true },
    },
  );
  // The spec allows only an SSE stream or 405 on GET. A stateless server has no stream to
  // offer and no session to end, and a client that gets 404 instead drops the connection.
  app.get('/mcp', methodNotAllowed, { detail: { hide: true } });
  app.delete('/mcp', methodNotAllowed, { detail: { hide: true } });
}

function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
    { status: 405, headers: { allow: 'POST' } },
  );
}
