// The filters of the issue read behind the list and search routes.
export interface IssueQuery {
  query?: string;
  columnId?: number;
  typeId?: number | null;
  initiativeId?: number | null;
  cycleId?: number | null;
  parentId?: number | null;
  assigneeUserId?: string | null;
  priority?: string | null;
  labelIds?: number[];
  dueFrom?: string;
  dueTo?: string;
  limit?: number;
}
