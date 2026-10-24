import { routeTools } from '#mcp/generate';
import type { Permission } from '#shared/guards';
import { getMcpApp } from '#mcp/app-ref';
import { AGENT_ACTIONS, ALWAYS_ON_ACTIONS, type ToolMeta } from './catalog';

// The catalog list_ai_agent_tools returns: each action with the permission its route
// asserts, so a caller can tell which role an action needs. An action with no route
// behind it, or one whose route asks only for project membership, has none.
export function actionCatalog(): (ToolMeta & { permission?: Permission })[] {
  const byName = new Map(routeTools(getMcpApp()).map((route) => [route.name, route]));
  return [...AGENT_ACTIONS, ...ALWAYS_ON_ACTIONS].map((action) => ({
    ...action,
    permission: byName.get(action.key)?.permission,
  }));
}
