import { FkLink, GroupTableConfig, tableKeyOf } from '../../types/configReplicate';

export const parentKeyOf = (link: FkLink): string =>
  `${link.parentSchema}.${link.parentTable}`;

export const effectiveLinks = (table: GroupTableConfig): FkLink[] => {
  if (table.fkLinks && table.fkLinks.length > 0) return table.fkLinks;

  return Object.entries(table.fkRemap || {}).map(([column, parent]) => {
    const separator = parent.indexOf('.');
    return {
      columns: [column],
      parentSchema: separator > 0 ? parent.slice(0, separator) : 'public',
      parentTable: separator > 0 ? parent.slice(separator + 1) : parent,
      parentColumns: [],
      source: 'MANUAL' as const,
    };
  });
};

const edgesOf = (tables: GroupTableConfig[]): Map<string, Set<string>> => {
  const present = new Set(tables.map(tableKeyOf));
  const children = new Map<string, Set<string>>();

  for (const table of tables) {
    const child = tableKeyOf(table);
    for (const link of effectiveLinks(table)) {
      const parent = parentKeyOf(link);
      if (parent === child || !present.has(parent)) continue;
      const bucket = children.get(parent);
      if (bucket) bucket.add(child);
      else children.set(parent, new Set([child]));
    }
  }

  return children;
};

export interface OrderResult {
  order: string[];
  cycles: string[][];
}

export const topologicalOrder = (tables: GroupTableConfig[]): OrderResult => {
  const children = edgesOf(tables);

  const inDegree = new Map<string, number>();
  for (const table of tables) inDegree.set(tableKeyOf(table), 0);
  for (const targets of children.values()) {
    for (const child of targets) inDegree.set(child, (inDegree.get(child) || 0) + 1);
  }

  const rank = new Map<string, number>();
  [...tables]
    .sort((a, b) => a.position - b.position || tableKeyOf(a).localeCompare(tableKeyOf(b)))
    .forEach((table, index) => rank.set(tableKeyOf(table), index));

  const ready = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([key]) => key);

  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    const next = ready.shift() as string;
    order.push(next);

    for (const child of children.get(next) || []) {
      const remaining = (inDegree.get(child) || 0) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }

  const placed = new Set(order);
  const stuck = tables
    .map(tableKeyOf)
    .filter(key => !placed.has(key))
    .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

  return { order, cycles: stuck.length > 0 ? [stuck] : [] };
};

export interface OrderViolation {
  child: string;
  parent: string;
}

export const orderViolations = (tables: GroupTableConfig[]): OrderViolation[] => {
  const positionOf = new Map(tables.map(t => [tableKeyOf(t), t.position]));
  const violations: OrderViolation[] = [];
  const seen = new Set<string>();

  for (const table of tables) {
    const child = tableKeyOf(table);
    for (const link of effectiveLinks(table)) {
      const parent = parentKeyOf(link);
      if (parent === child || !positionOf.has(parent)) continue;
      if ((positionOf.get(parent) as number) < (positionOf.get(child) as number)) continue;

      const fingerprint = `${child}<-${parent}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      violations.push({ child, parent });
    }
  }

  return violations;
};

export const sortTables = (tables: GroupTableConfig[]): GroupTableConfig[] => {
  const { order, cycles } = topologicalOrder(tables);
  if (cycles.length > 0) return tables;

  const byKey = new Map(tables.map(t => [tableKeyOf(t), t]));
  return order.map((key, index) => ({ ...(byKey.get(key) as GroupTableConfig), position: index }));
};
