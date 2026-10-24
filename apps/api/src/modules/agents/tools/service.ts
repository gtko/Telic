import { type Db, agentTool, agentToolLink, integrationCredential } from '@repo/db';
import { batchAll, chunk } from '../core/helpers/batch';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getTool, type ToolConfig } from '@repo/agent-tools';
import { iso, HttpError, rethrowDuplicate } from '#shared/lib';
import { decryptSecret } from '@repo/crypto';
import { getCredentialById } from '../integrations/service';

// Data access for configured tools, shared by every project the team owns. A
// configured tool binds a catalog tool (tool_key) to one integration_credential of the
// team. The secret lives on the credential, so a row here carries no secret; the
// runtime decrypts the bound credential at call time. The list DTO enriches a row with
// its credential's integration and label for display.

export interface AgentToolRow {
  id: number;
  teamId: number;
  toolKey: string;
  credentialId: number;
  integrationKey: string;
  credentialLabel: string | null;
  createdAt: string;
}

const dtoColumns = {
  id: agentTool.id,
  teamId: agentTool.teamId,
  toolKey: agentTool.toolKey,
  credentialId: agentTool.credentialId,
  integrationKey: integrationCredential.integrationKey,
  credentialLabel: integrationCredential.label,
  createdAt: agentTool.createdAt,
};

function mapRow(row: Omit<AgentToolRow, 'createdAt'> & { createdAt: Date }): AgentToolRow {
  return { ...row, createdAt: iso(row.createdAt) };
}

function selectTools(db: Db) {
  return db
    .select(dtoColumns)
    .from(agentTool)
    .innerJoin(integrationCredential, eq(integrationCredential.id, agentTool.credentialId));
}

// One page of the team's configured tools, by tool key, with how many it holds in
// total.
export async function listAgentTools(
  db: Db,
  teamId: number,
  window: { limit: number; offset: number },
): Promise<{ items: AgentToolRow[]; total: number }> {
  const where = eq(agentTool.teamId, teamId);
  const [rows, counted] = await Promise.all([
    selectTools(db)
      .where(where)
      .orderBy(agentTool.toolKey)
      .limit(window.limit)
      .offset(window.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(agentTool)
      .where(where),
  ]);
  return { items: rows.map(mapRow), total: counted[0]?.count ?? 0 };
}

// The whole list, by tool key. What the picker that enables tools on an agent and the
// dialog that adds one read.
export async function listAgentToolOptions(db: Db, teamId: number): Promise<AgentToolRow[]> {
  const rows = await selectTools(db).where(eq(agentTool.teamId, teamId)).orderBy(agentTool.toolKey);
  return rows.map(mapRow);
}

async function getAgentToolById(db: Db, id: number, teamId: number): Promise<AgentToolRow | null> {
  const rows = await selectTools(db).where(and(eq(agentTool.id, id), eq(agentTool.teamId, teamId)));
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface NewAgentToolInput {
  toolKey: string;
  credentialId: number;
}

export async function createAgentTool(
  db: Db,
  teamId: number,
  input: NewAgentToolInput,
): Promise<AgentToolRow> {
  const tool = getTool(input.toolKey);
  if (!tool) throw new HttpError(400, `Unknown tool: ${input.toolKey}`);
  const credential = await getCredentialById(db, input.credentialId, teamId);
  if (!credential) throw new HttpError(400, 'Credential not found');
  if (credential.integrationKey !== tool.integration.key) {
    throw new HttpError(
      400,
      `This tool needs a ${tool.integration.label} credential, not ${credential.integrationKey}.`,
    );
  }
  try {
    const [row] = await db
      .insert(agentTool)
      .values({ teamId, toolKey: input.toolKey, credentialId: input.credentialId })
      .returning({ id: agentTool.id });
    return (await getAgentToolById(db, row.id, teamId))!;
  } catch (err) {
    rethrowDuplicate(err, 'This tool on this credential');
    throw err;
  }
}

export async function deleteAgentTool(db: Db, id: number, teamId: number): Promise<boolean> {
  const deleted = await db
    .delete(agentTool)
    .where(and(eq(agentTool.id, id), eq(agentTool.teamId, teamId)))
    .returning({ id: agentTool.id });
  return deleted.length > 0;
}

// The configured tools enabled on an agent, as DTOs (no secret). Used by the agent
// editor.
export async function listAgentToolLinks(db: Db, agentId: number): Promise<AgentToolRow[]> {
  const rows = await db
    .select(dtoColumns)
    .from(agentToolLink)
    .innerJoin(agentTool, eq(agentTool.id, agentToolLink.agentToolId))
    .innerJoin(integrationCredential, eq(integrationCredential.id, agentTool.credentialId))
    .where(eq(agentToolLink.agentId, agentId))
    .orderBy(agentTool.toolKey);
  return rows.map(mapRow);
}

// The decrypted tools enabled on an agent, for the runtime to build tools: each tool's
// key and its bound credential. Not exposed over HTTP.
export async function listAgentToolsForRun(
  db: Db,
  agentId: number,
): Promise<{ id: number; toolKey: string; credential: ToolConfig }[]> {
  const rows = await db
    .select({
      id: agentTool.id,
      toolKey: agentTool.toolKey,
      ciphertext: integrationCredential.ciphertext,
      iv: integrationCredential.iv,
      authTag: integrationCredential.authTag,
    })
    .from(agentToolLink)
    .innerJoin(agentTool, eq(agentTool.id, agentToolLink.agentToolId))
    .innerJoin(integrationCredential, eq(integrationCredential.id, agentTool.credentialId))
    .where(eq(agentToolLink.agentId, agentId));
  return rows.map((r) => ({
    id: r.id,
    toolKey: r.toolKey,
    credential: JSON.parse(
      decryptSecret({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.authTag }),
    ) as ToolConfig,
  }));
}

// Unknown ids and ids from another team are ignored, not rejected.
export async function setAgentTools(
  db: Db,
  agentId: number,
  teamId: number,
  agentToolIds: number[],
): Promise<void> {
  const unique = [...new Set(agentToolIds)];
  const valid: number[] = [];
  for (const ids of chunk(unique)) {
    const rows = await db
      .select({ id: agentTool.id })
      .from(agentTool)
      .where(and(eq(agentTool.teamId, teamId), inArray(agentTool.id, ids)));
    valid.push(...rows.map((r) => r.id));
  }

  // One atomic batch (two bound parameters per link, 100 at most per statement).
  await batchAll(db, [
    db.delete(agentToolLink).where(eq(agentToolLink.agentId, agentId)),
    ...chunk(valid, 45).map((ids) =>
      db.insert(agentToolLink).values(ids.map((agentToolId) => ({ agentId, agentToolId }))),
    ),
  ]);
}
