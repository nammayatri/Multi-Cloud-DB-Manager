import type { DbMap } from '../Selector/databaseTopology';

/**
 * Work out which database a query is for from the schemas it names.
 *
 * `atlas_app.booking` can only mean the database that has an `atlas_app`
 * schema, so there's no reason to make the requester pick it by hand. The
 * mapping comes from the configured topology rather than a hardcoded list —
 * whichever database lists a schema owns it.
 *
 * Returns null whenever the answer isn't certain: no qualified names, schemas
 * nobody owns, or schemas that belong to different databases. The caller then
 * leaves the target as it is.
 */
export interface DetectedTarget {
  database: string;
  /** The schema the query names, when it names exactly one. */
  pgSchema?: string;
  /** Every configured schema the query referenced, for telling the user why. */
  schemas: string[];
}

/** Drop comments and string literals, so `'atlas_app.x'` in a value doesn't count. */
const stripNoise = (sql: string): string =>
  sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");

/** Every `schema.` qualifier in the SQL, bare or double-quoted, lowercased if bare. */
const referencedQualifiers = (sql: string): Set<string> => {
  const found = new Set<string>();
  const pattern = /(?:"((?:[^"]|"")+)"|\b([A-Za-z_][\w$]*))\s*\.\s*(?:"|[A-Za-z_])/g;
  for (const match of stripNoise(sql).matchAll(pattern)) {
    found.add(match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2].toLowerCase());
  }
  return found;
};

export const detectTargetFromSql = (sql: string, dbMap: DbMap): DetectedTarget | null => {
  const qualifiers = referencedQualifiers(sql);
  if (qualifiers.size === 0) return null;

  // Most qualifiers are table aliases (`b.id`); only the ones that are a
  // configured schema somewhere say anything about the target.
  const owners = new Map<string, Set<string>>();
  for (const [database, meta] of Object.entries(dbMap)) {
    for (const schema of meta.schemas || []) {
      if (!qualifiers.has(schema) && !qualifiers.has(schema.toLowerCase())) continue;
      if (!owners.has(schema)) owners.set(schema, new Set());
      owners.get(schema)!.add(database);
    }
  }
  if (owners.size === 0) return null;

  // The database has to own every schema referenced — a query spanning two
  // databases can't run on either, and that's for the requester to sort out.
  const [first, ...rest] = [...owners.values()];
  const candidates = [...first].filter((db) => rest.every((dbs) => dbs.has(db)));
  if (candidates.length !== 1) return null;

  const [database] = candidates;
  const schemas = [...owners.keys()];

  return {
    database,
    pgSchema: schemas.length === 1 ? schemas[0] : undefined,
    schemas,
  };
};
