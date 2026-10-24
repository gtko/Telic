import type { Assignee } from '@/lib/api/endpoints/projects';
import Avatar from '@/components/common/Avatar';
import type { PickItem } from '@/components/common/fields/PopoverPick';

// Builds the row one candidate gets in a picker over the project's people, shared by
// the controls that write such a candidate to an issue.
export function useCandidatePickItem(
  assignees: Assignee[],
  value: string | null,
  onChange: (userId: string) => void,
) {
  return (a: Assignee): PickItem => {
    return {
      key: a.userId,
      search: a.name,
      icon: <Avatar name={a.name} image={a.image} className="size-4 text-[8px]" />,
      label: a.name,
      selected: a.userId === value,
      onSelect: () => onChange(a.userId),
    };
  };
}
