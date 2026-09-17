import { FkLink } from '../../types/configReplicate';
import { canonical } from './values';

export type Row = Record<string, unknown>;

const PENDING_PREFIX = 'configReplicate:pendingParent:';

export const idMapKey = (
  parentTableKey: string,
  parentColumns: string[],
  values: unknown[],
  udts: Array<string | undefined> = []
): string =>
  `${parentTableKey}(${parentColumns.join(',')})=` +
  values.map((value, i) => canonical(value, udts[i])).join('\u0000');

export const pendingRef = (
  parentTableKey: string,
  parentColumn: string,
  keyColumns: string[],
  values: unknown[],
  udts: Array<string | undefined> = []
): string =>
  `${PENDING_PREFIX}${idMapKey(parentTableKey, keyColumns, values, udts)}#${parentColumn}`;

export const isPendingRef = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PENDING_PREFIX);

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
  links: FkLink[],
  idMap: Map<string, unknown>,
  udtMap: Record<string, string>
): ProjectedRow => {
  if (!links || links.length === 0) return { row, dangling: [] };

  const projected: Row = { ...row };
  const dangling: string[] = [];

  for (const link of links) {
    const originals = link.columns.map(column => row[column]);
    if (originals.some(value => value === null || value === undefined)) continue;

    const parentTableKey = `${link.parentSchema}.${link.parentTable}`;
    const mapped = idMap.get(
      idMapKey(
        parentTableKey,
        link.parentColumns,
        originals,
        link.columns.map(column => udtMap[column])
      )
    );

    if (mapped === undefined) {
      dangling.push(...link.columns);
      continue;
    }

    const values = mapped as unknown[];
    link.columns.forEach((column, i) => {
      projected[column] = values[i];
    });
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
