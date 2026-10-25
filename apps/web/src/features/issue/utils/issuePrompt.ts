import type { Issue } from '@/lib/api/endpoints/issues';
import { transliterate } from '@/utils/transliterate';

// A git-branch-safe handle from the current user: "poluosmak.a@gmail.com" ->
// "poluosmaka". Empty when there is no user, which drops the branch prefix.
function userHandle(name: string | null | undefined, email: string | null | undefined): string {
  const base = email ? email.split('@')[0] : (name ?? '');
  return transliterate(base)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function titleSlug(title: string): string {
  return transliterate(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

export function buildIssueBranchName(
  issue: Pick<Issue, 'identifier' | 'title'>,
  user?: { name?: string | null; email?: string | null },
): string {
  const handle = userHandle(user?.name, user?.email);
  const slug = titleSlug(issue.title);
  const id = issue.identifier.toLowerCase();
  return `${handle ? `${handle}/` : ''}${slug ? `${id}-${slug}` : id}`;
}
