const ARCHIVED_ACTIONS = new Set(['delegate', 'agent_started', 'agent_finished']);

export function isArchivedActivity(action: string): boolean {
  return ARCHIVED_ACTIONS.has(action);
}
