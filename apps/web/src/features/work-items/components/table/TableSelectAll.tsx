import { useTranslations } from 'next-intl';
import { MatrixCheckbox } from '@/components/common/inputs/MatrixCheckbox';
import { useSelection } from '../../context/useSelection';
import { selectedState } from '../../utils/table';

// Select-all box over a set of issue ids: a group's, or the whole table's. Checked
// when all of them are selected, indeterminate when some are. Renders nothing for
// an empty set.
export function TableSelectAll({ ids }: { ids: number[] }) {
  const t = useTranslations('workItems');
  const selection = useSelection();
  if (ids.length === 0) return null;
  const checked = selectedState(ids, selection.selected);
  return (
    <MatrixCheckbox
      checked={checked}
      aria-label={checked === true ? t('deselectAll') : t('selectAll')}
      onClick={(e) => {
        e.stopPropagation();
        if (checked === true) selection.remove(ids);
        else selection.add(ids);
      }}
    />
  );
}
