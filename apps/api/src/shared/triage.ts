import { projectColumn } from '@repo/db';
import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// Issues in a column of state type 'triage' are hidden from lists, counts and feeds.
// Only a read by id or number reaches them. Pass the column that holds the issue's
// column id, as a column or as a SQL expression when the issue table is aliased.
export function notInTriage(columnId: AnySQLiteColumn | SQL): SQL {
  return sql`${columnId} not in (select ${projectColumn.id} from ${projectColumn} where ${projectColumn.stateType} = 'triage')`;
}
