import { useMemo } from 'react';
import { type WorkItemsViewProps } from '@/utils/project';
import { SelectionProvider } from '../../context/useSelection';
import { BulkActionBar } from '../kanban/BulkActionBar';
import TableList from './TableList';

export interface TableViewProps extends WorkItemsViewProps {
  // Which stored set of column widths this table uses: a saved view's own, the
  // All tab's, or the single set every cycle / initiative board shares.
  widthScope: string;
}

// The table with the kanban's multi-select: the provider holds the selection and
// the bulk-action bar acts on it. `validIds` are the issues on screen, so a
// selected issue that leaves them drops from the selection.
export default function TableView(props: TableViewProps) {
  const validIds = useMemo(
    () => new Set(props.project.issues.map((i) => i.id)),
    [props.project.issues],
  );

  return (
    <SelectionProvider validIds={validIds}>
      <TableList {...props} />
      {!props.readOnly && <BulkActionBar project={props.project} />}
    </SelectionProvider>
  );
}
