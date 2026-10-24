export const OWNER_VALUE = 'owner';

// The role the dialog submits: the one picked, unless that is an owner no longer on
// offer, and otherwise the team's default.
export function chosenRole(
  roleValue: string,
  defaultRoleId: number | undefined,
  owner: boolean,
): string {
  if (roleValue && (roleValue !== OWNER_VALUE || owner)) return roleValue;
  return defaultRoleId != null ? String(defaultRoleId) : '';
}
