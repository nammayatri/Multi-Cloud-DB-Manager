import { canonical } from './values';

export type Row = Record<string, unknown>;

const PENDING_PREFIX = 'configReplicate:pendingParent:';

export const pendingRef = (parentTableKey: string, oldValue: unknown, udt?: string): string =>
  `${PENDING_PREFIX}${parentTableKey}:${canonical(oldValue, udt)}`;

export const isPendingRef = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PENDING_PREFIX);

export const idMapKey = (parentTableKey: string, oldValue: unknown, udt?: string): string =>
  `${parentTableKey}:${canonical(oldValue, udt)}`;

export interface ProjectedRow {
  row: Row;
  dangling: string[];
}

/**
 * Rewrites a base row's configured foreign keys to the new dimension's parents.
 * This must happen during analysis, not only at apply: when the remapped column
 * is also part of the match key, an un-projected base row can never equal its
 * target counterpart and every row is reported as an insert plus a delete.
 */
export const projectRow = (
  row: Row,
  fkRemap: Record<string, string>,
  idMap: Map<string, unknown>,
  udtMap: Record<string, string>
): ProjectedRow => {
  const entries = Object.entries(fkRemap || {});
  if (entries.length === 0) return { row, dangling: [] };

  const projected: Row = { ...row };
  const dangling: string[] = [];

  for (const [column, parentTableKey] of entries) {
    const original = row[column];
    if (original === null || original === undefined) continue;

    const mapped = idMap.get(idMapKey(parentTableKey, original, udtMap[column]));
    if (mapped === undefined) {
      dangling.push(column);
      continue;
    }
    projected[column] = mapped;
  }

  return { row: projected, dangling };
};

export const resolvePending = (value: unknown, minted: Map<string, unknown>): unknown => {
  if (!isPendingRef(value)) return value;
  const resolved = minted.get(value);
  if (resolved === undefined) {
    throw new Error(
      'A row references a parent that was not part of this apply. ' +
        'Select the parent rows too, or clear the reference mapping for that column.'
    );
  }
  return resolved;
};
