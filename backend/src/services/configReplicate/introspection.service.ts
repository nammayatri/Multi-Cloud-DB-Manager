import { PoolClient } from 'pg';
import { ColumnInfo, ForeignKeyInfo, UniqueKeyInfo } from '../../types/configReplicate';

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

export const listTablesWithDimension = async (
  client: PoolClient,
  dimensionColumns: string[]
): Promise<Array<{ schema: string; table: string; dimensionColumns: string[] }>> => {
  // Only tables carrying EVERY dimension column qualify. A table missing one of
  // them cannot be sliced by the dimension at all: filtering on the rest would
  // match rows belonging to other dimension values.
  const result = await client.query(
    `SELECT c.table_schema, c.table_name
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema
      AND t.table_name   = c.table_name
      AND t.table_type   = 'BASE TABLE'
     WHERE c.table_schema <> ALL($1::text[])
       AND c.column_name = ANY($2::text[])
     GROUP BY c.table_schema, c.table_name
     HAVING COUNT(DISTINCT c.column_name) = $3
     ORDER BY c.table_schema, c.table_name`,
    [SYSTEM_SCHEMAS, dimensionColumns, dimensionColumns.length]
  );

  return result.rows.map((r: any) => ({
    schema: r.table_schema,
    table: r.table_name,
    dimensionColumns,
  }));
};

export const listTables = async (
  client: PoolClient
): Promise<Array<{ schema: string; table: string }>> => {
  const result = await client.query(
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_schema <> ALL($1::text[])
     ORDER BY table_schema, table_name`,
    [SYSTEM_SCHEMAS]
  );

  return result.rows.map((r: any) => ({ schema: r.table_schema, table: r.table_name }));
};

export const getColumns = async (
  client: PoolClient,
  schema: string,
  table: string
): Promise<ColumnInfo[]> => {
  const result = await client.query(
    `SELECT column_name, ordinal_position, data_type, udt_name, is_nullable,
            column_default, is_identity, is_generated
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table]
  );

  return result.rows.map((r: any) => ({
    columnName: r.column_name,
    ordinalPosition: r.ordinal_position,
    dataType: r.data_type,
    udtName: r.udt_name,
    isNullable: r.is_nullable === 'YES',
    columnDefault: r.column_default,
    isIdentity: r.is_identity === 'YES',
    isGenerated: r.is_generated === 'ALWAYS',
  }));
};

export const getUniqueKeys = async (
  client: PoolClient,
  schema: string,
  table: string
): Promise<UniqueKeyInfo[]> => {
  const constraints = await client.query(
    `SELECT c.conname AS name,
            c.contype AS contype,
            array_agg(a.attname::text ORDER BY k.ord) AS columns
     FROM pg_constraint c
     JOIN pg_class     t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE n.nspname = $1 AND t.relname = $2
       AND c.contype IN ('p', 'u')
     GROUP BY c.conname, c.contype
     ORDER BY c.contype, c.conname`,
    [schema, table]
  );

  const indexes = await client.query(
    `SELECT i.relname AS name,
            ix.indisprimary AS is_primary,
            array_agg(a.attname::text ORDER BY k.ord) AS columns
     FROM pg_index ix
     JOIN pg_class     t ON t.oid = ix.indrelid
     JOIN pg_class     i ON i.oid = ix.indexrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE n.nspname = $1 AND t.relname = $2
       AND ix.indisunique
       AND ix.indpred  IS NULL
       AND ix.indexprs IS NULL
     GROUP BY i.relname, ix.indisprimary`,
    [schema, table]
  );

  const keys: UniqueKeyInfo[] = [];
  const seen = new Set<string>();

  const add = (name: string, columns: string[], isPrimary: boolean) => {
    const fingerprint = [...columns].sort().join('');
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    keys.push({ name, columns, isPrimary });
  };

  for (const row of constraints.rows as any[]) {
    add(row.name, row.columns, row.contype === 'p');
  }
  for (const row of indexes.rows as any[]) {
    add(row.name, row.columns, row.is_primary);
  }

  return keys;
};

export const getForeignKeys = async (
  client: PoolClient,
  qualifiedTables: string[]
): Promise<ForeignKeyInfo[]> => {
  if (qualifiedTables.length === 0) return [];

  const result = await client.query(
    `SELECT c.conname AS name,
            cn.nspname AS child_schema,  ct.relname AS child_table,
            pn.nspname AS parent_schema, pt.relname AS parent_table,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_columns,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_columns
     FROM pg_constraint c
     JOIN pg_class     ct ON ct.oid = c.conrelid
     JOIN pg_namespace cn ON cn.oid = ct.relnamespace
     JOIN pg_class     pt ON pt.oid = c.confrelid
     JOIN pg_namespace pn ON pn.oid = pt.relnamespace
     WHERE c.contype = 'f'
       AND cn.nspname || '.' || ct.relname = ANY($1::text[])
       AND pn.nspname || '.' || pt.relname = ANY($1::text[])`,
    [qualifiedTables]
  );

  return result.rows.map((r: any) => ({
    name: r.name,
    childSchema: r.child_schema,
    childTable: r.child_table,
    childColumns: r.child_columns || [],
    parentSchema: r.parent_schema,
    parentTable: r.parent_table,
    parentColumns: r.parent_columns || [],
  }));
};

export const schemaFingerprint = (
  columns: ColumnInfo[],
  keys: UniqueKeyInfo[]
): string => {
  const columnPart = columns
    .map(c => `${c.columnName}:${c.udtName}:${c.isNullable ? 'n' : 'N'}`)
    .join('|');
  const keyPart = keys
    .map(k => `${k.isPrimary ? 'p' : 'u'}(${[...k.columns].sort().join(',')})`)
    .sort()
    .join('|');
  return `${columnPart}#${keyPart}`;
};
