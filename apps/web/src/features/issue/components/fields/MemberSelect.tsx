import { CircleDashed } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Assignee } from '@/lib/api/endpoints/projects';
import Avatar from '@/components/common/Avatar';
import { Pill } from '@/components/common/fields/Pill';
import PopoverPick from '@/components/common/fields/PopoverPick';
import { useCandidatePickItem } from '../../hooks/useCandidatePickItem';

// The person a member custom field holds. Shaped like AssigneeSelect, which does the
// same for the built-in field.
export default function MemberSelect({
  assignees,
  value,
  onChange,
  placeholder,
}: {
  assignees: Assignee[];
  value: string | null;
  onChange: (userId: string | null) => void;
  placeholder?: string;
}) {
  const t = useTranslations('issue.fieldSelects');
  const none = t('noMember');
  const options = assignees;
  const selected = options.find((a) => a.userId === value);
  const toItem = useCandidatePickItem(value, onChange);

  return (
    <PopoverPick
      trigger={
        <Pill active={!!selected}>
          {selected ? (
            <Avatar name={selected.name} image={selected.image} className="size-4 text-[8px]" />
          ) : (
            <CircleDashed />
          )}
          <span className="truncate">{selected?.name ?? placeholder ?? none}</span>
        </Pill>
      }
      inputPlaceholder={t('pickMember')}
      emptyText={t('noCandidates')}
      items={[
        {
          key: 'none',
          search: none,
          icon: <CircleDashed />,
          label: none,
          selected: value == null,
          onSelect: () => onChange(null),
        },
        ...options.map(toItem),
      ]}
    />
  );
}
