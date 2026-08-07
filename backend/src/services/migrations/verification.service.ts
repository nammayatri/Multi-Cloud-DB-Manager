import { PoolClient } from 'pg';
import logger from '../../utils/logger';
import { MigrationStatement } from '../../types/migrations';
import { ParsedStatement } from './sql-parser.service';

/**
 * Canonicalize a PostgreSQL type name so a target type from migration SQL and
 * the live type from pg_catalog.format_type compare equal regardless of
 * spelling, spacing, or alias. Both sides are reduced to a single canonical
 * short form (e.g. varchar, int4, timestamptz, float8), with precision/scale
 * and array `[]` preserved and normalized.
 *
 *   "numeric(30, 15)"                -> "numeric(30,15)"
 *   "character varying(36)"          -> "varchar(36)"
 *   "text []"                        -> "text[]"
 *   "integer" / "int" / "int4"       -> "int4"
 *   "timestamp with time zone"       -> "timestamptz"
 *   "double precision"               -> "float8"
 */
export function normalizePgType(raw: string): string {
  let s = (raw || '').toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace(/\s*\[\s*\]/g, '[]');                 // "text []" -> "text[]"
  s = s.replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').replace(/\s*,\s*/g, ','); // "( 30 , 15 )" -> "(30,15)"
  const aliases: Array<[RegExp, string]> = [
    [/\bcharacter varying\b/g, 'varchar'],
    [/\bcharacter\b(?!\s+varying)/g, 'char'],
    [/\bbpchar\b/g, 'char'],
    [/\bdouble precision\b/g, 'float8'],
    [/\btimestamp with time zone\b/g, 'timestamptz'],
    [/\btimestamp without time zone\b/g, 'timestamp'],
    [/\btime with time zone\b/g, 'timetz'],
    [/\btime without time zone\b/g, 'time'],
    [/\bboolean\b/g, 'bool'],
    [/\binteger\b/g, 'int4'],
    [/\bbigint\b/g, 'int8'],
    [/\bsmallint\b/g, 'int2'],
    [/\bint\b/g, 'int4'],
    [/\breal\b/g, 'float4'],
    [/\bdecimal\b/g, 'numeric'],
  ];
  for (const [re, to] of aliases) s = s.replace(re, to);
  return s;
}

/**
 * Generate a rollback SQL statement for a given forward SQL statement.
 * Returns undefined if rollback cannot be auto-generated.
 */
function generateRollback(parsed: ParsedStatement): string | undefined {
  const { operation, objectName, sql } = parsed;

  switch (operation) {
    case 'CREATE TABLE': {
      // objectName: schema.table
      return `DROP TABLE IF EXISTS ${objectName};`;
    }

    case 'ADD COLUMN': {
      // objectName: schema.table.column
      const parts = objectName.split('.');
      if (parts.length < 3) return undefined;
      const [schema, table, column] = parts;
      return `ALTER TABLE ${schema}.${table} DROP COLUMN IF EXISTS ${column};`;
    }

    case 'DROP COLUMN': {
      return `-- Cannot auto-rollback DROP COLUMN (data lost)`;
    }

    case 'ALTER COLUMN':
    case 'ALTER COLUMN TYPE': {
      const upper = sql.toUpperCase();

      if (upper.includes('SET NOT NULL')) {
        const parts = objectName.split('.');
        if (parts.length < 3) return undefined;
        const [schema, table, column] = parts;
        return `ALTER TABLE ${schema}.${table} ALTER COLUMN ${column} DROP NOT NULL;`;
      }

      if (upper.includes('DROP NOT NULL')) {
        const parts = objectName.split('.');
        if (parts.length < 3) return undefined;
        const [schema, table, column] = parts;
        return `ALTER TABLE ${schema}.${table} ALTER COLUMN ${column} SET NOT NULL;`;
      }

      if (upper.includes('SET DEFAULT')) {
        const parts = objectName.split('.');
        if (parts.length < 3) return undefined;
        const [schema, table, column] = parts;
        return `ALTER TABLE ${schema}.${table} ALTER COLUMN ${column} DROP DEFAULT;`;
      }

      if (upper.includes('DROP DEFAULT')) {
        return `-- Cannot auto-rollback DROP DEFAULT (original value unknown)`;
      }

      if (operation === 'ALTER COLUMN TYPE') {
        return `-- Cannot auto-rollback TYPE change (original type unknown)`;
      }

      return undefined;
    }

    case 'CREATE INDEX': {
      // objectName: schema.indexname
      return `DROP INDEX IF EXISTS ${objectName};`;
    }

    case 'DROP INDEX': {
      return `-- Cannot auto-rollback DROP INDEX (definition unknown)`;
    }

    case 'CREATE TYPE': {
      // objectName: schema.typename
      return `DROP TYPE IF EXISTS ${objectName};`;
    }

    case 'ALTER TYPE ADD VALUE': {
      return `-- Cannot remove enum values in PostgreSQL`;
    }

    case 'ADD CONSTRAINT': {
      // objectName: schema.table/constraintName
      const slashIdx = objectName.indexOf('/');
      if (slashIdx === -1) return undefined;
      const qualifiedTable = objectName.substring(0, slashIdx);
      const constraintName = objectName.substring(slashIdx + 1);
      return `ALTER TABLE ${qualifiedTable} DROP CONSTRAINT IF EXISTS ${constraintName};`;
    }

    case 'DROP CONSTRAINT': {
      return `-- Cannot auto-rollback DROP CONSTRAINT (definition unknown)`;
    }

    case 'INSERT': {
      return `-- Cannot auto-rollback INSERT (need primary key)`;
    }

    case 'UPDATE': {
      return `-- Cannot auto-rollback UPDATE (original values unknown)`;
    }

    case 'DELETE': {
      return `-- Cannot auto-rollback DELETE (original rows unknown)`;
    }

    default:
      return undefined;
  }
}

/**
 * Verify whether a single parsed SQL statement has been applied to the database.
 * Uses only parameterized queries against information_schema / pg_catalog.
 */
export async function verifyStatement(
  client: PoolClient,
  parsed: ParsedStatement,
  defaultSchema: string
): Promise<MigrationStatement> {
  const rollbackSql = generateRollback(parsed);
  const base: MigrationStatement = {
    sql: parsed.sql,
    type: parsed.type,
    operation: parsed.operation,
    objectName: parsed.objectName,
    status: 'manual_check',
    details: '',
    rollbackSql,
  };

  // Skip non-verifiable operations
  if (parsed.objectName === 'skipped' || parsed.operation === 'SKIPPED' || parsed.operation === 'OWNER') {
    return { ...base, status: 'skipped', details: 'Operation skipped (not verifiable)' };
  }

  try {
    switch (parsed.operation) {
      case 'CREATE TABLE': {
        const [schema, table] = parsed.objectName.split('.');
        const q = 'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2';
        const res = await client.query(q, [schema, table]);
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'applied' : 'pending',
          details: res.rowCount && res.rowCount > 0 ? `Table ${schema}.${table} exists` : `Table ${schema}.${table} not found`,
          verificationQuery: q,
        };
      }

      case 'ADD COLUMN': {
        // objectName: schema.table.column
        const parts = parsed.objectName.split('.');
        if (parts.length < 3) {
          return { ...base, status: 'manual_check', details: 'Could not parse column name' };
        }
        const [schema, table, column] = parts;
        const q = 'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3';
        const res = await client.query(q, [schema, table, column]);
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'applied' : 'pending',
          details: res.rowCount && res.rowCount > 0
            ? `Column ${column} exists in ${schema}.${table}`
            : `Column ${column} not found in ${schema}.${table}`,
          verificationQuery: q,
        };
      }

      case 'DROP COLUMN': {
        const parts = parsed.objectName.split('.');
        if (parts.length < 3) {
          return { ...base, status: 'manual_check', details: 'Could not parse column name' };
        }
        const [schema, table, column] = parts;
        const q = 'SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3';
        const res = await client.query(q, [schema, table, column]);
        // If column still exists, drop hasn't been applied
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'pending' : 'applied',
          details: res.rowCount && res.rowCount > 0
            ? `Column ${column} still exists in ${schema}.${table} (drop pending)`
            : `Column ${column} not found in ${schema}.${table} (drop applied)`,
          verificationQuery: q,
        };
      }

      case 'ALTER COLUMN TYPE': {
        // objectName: schema.table.col/targetType
        const slashIdx = parsed.objectName.indexOf('/');
        const colPath = slashIdx !== -1 ? parsed.objectName.substring(0, slashIdx) : parsed.objectName;
        const targetType = slashIdx !== -1 ? parsed.objectName.substring(slashIdx + 1) : null;
        const parts = colPath.split('.');
        if (parts.length < 3) {
          return { ...base, status: 'manual_check', details: 'Could not parse column name' };
        }
        const [schema, table, column] = parts;
        if (!targetType) {
          return { ...base, status: 'manual_check', details: 'Could not parse target type' };
        }
        // Use pg_catalog.format_type so we get the FULL canonical type, including
        // precision/scale and array notation — e.g. "numeric(30,15)",
        // "character varying(36)", "text[]". information_schema.udt_name alone
        // drops the precision/scale and reports arrays as "_text", which made
        // every numeric(p,s) / array type change look pending even when applied.
        const q =
          'SELECT format_type(a.atttypid, a.atttypmod) AS full_type ' +
          'FROM pg_attribute a ' +
          'JOIN pg_class c ON c.oid = a.attrelid ' +
          'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
          'WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 ' +
          'AND a.attnum > 0 AND NOT a.attisdropped';
        const res = await client.query(q, [schema, table, column]);
        if (!res.rowCount || res.rowCount === 0) {
          return { ...base, status: 'pending', details: `Column ${column} not found in ${schema}.${table}`, verificationQuery: q };
        }
        const currentType = String(res.rows[0].full_type || '');
        const matched = normalizePgType(currentType) === normalizePgType(targetType);
        return {
          ...base,
          status: matched ? 'applied' : 'pending',
          details: matched
            ? `Column ${column} type is ${currentType} (matches ${targetType})`
            : `Column ${column} type is ${currentType}, expected ${targetType}`,
          verificationQuery: q,
        };
      }

      case 'ALTER COLUMN': {
        const parts = parsed.objectName.split('.');
        if (parts.length < 3) {
          return { ...base, status: 'manual_check', details: 'Could not parse column name' };
        }
        const [schema, table, column] = parts;
        const q = 'SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3';
        const res = await client.query(q, [schema, table, column]);
        if (!res.rowCount || res.rowCount === 0) {
          return { ...base, status: 'manual_check', details: `Column ${column} not found in ${schema}.${table}`, verificationQuery: q };
        }
        const isNullable = res.rows[0].is_nullable;
        const colDefault = res.rows[0].column_default;

        // SET NOT NULL
        if (parsed.sql.toUpperCase().includes('SET NOT NULL')) {
          return {
            ...base,
            status: isNullable === 'NO' ? 'applied' : 'pending',
            details: isNullable === 'NO'
              ? `Column ${column} is NOT NULL in ${schema}.${table}`
              : `Column ${column} is still nullable in ${schema}.${table}`,
            verificationQuery: q,
          };
        }

        // DROP NOT NULL
        if (parsed.sql.toUpperCase().includes('DROP NOT NULL')) {
          return {
            ...base,
            status: isNullable === 'YES' ? 'applied' : 'pending',
            details: isNullable === 'YES'
              ? `Column ${column} is nullable in ${schema}.${table} (DROP NOT NULL applied)`
              : `Column ${column} is still NOT NULL in ${schema}.${table}`,
            verificationQuery: q,
          };
        }

        // SET DEFAULT
        if (parsed.sql.toUpperCase().includes('SET DEFAULT')) {
          return {
            ...base,
            status: colDefault ? 'applied' : 'pending',
            details: colDefault
              ? `Column ${column} has default: ${colDefault}`
              : `Column ${column} has no default in ${schema}.${table}`,
            verificationQuery: q,
          };
        }

        // DROP DEFAULT
        if (parsed.sql.toUpperCase().includes('DROP DEFAULT')) {
          return {
            ...base,
            status: colDefault ? 'pending' : 'applied',
            details: colDefault
              ? `Column ${column} still has default: ${colDefault} (drop pending)`
              : `Column ${column} has no default in ${schema}.${table} (drop applied)`,
            verificationQuery: q,
          };
        }

        return { ...base, status: 'manual_check', details: `ALTER COLUMN on ${column} — nullable: ${isNullable}, default: ${colDefault || 'none'}`, verificationQuery: q };
      }

      case 'CREATE INDEX': {
        // objectName: schema.indexname
        const [schema, indexName] = parsed.objectName.split('.');
        const q = 'SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2';
        const res = await client.query(q, [schema, indexName]);
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'applied' : 'pending',
          details: res.rowCount && res.rowCount > 0
            ? `Index ${indexName} exists in ${schema}`
            : `Index ${indexName} not found in ${schema}`,
          verificationQuery: q,
        };
      }

      case 'DROP INDEX': {
        const [schema, indexName] = parsed.objectName.split('.');
        const q = 'SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2';
        const res = await client.query(q, [schema, indexName]);
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'pending' : 'applied',
          details: res.rowCount && res.rowCount > 0
            ? `Index ${indexName} still exists in ${schema} (drop pending)`
            : `Index ${indexName} not found in ${schema} (drop applied)`,
          verificationQuery: q,
        };
      }

      case 'CREATE TYPE': {
        const [schema, typeName] = parsed.objectName.split('.');
        const q = 'SELECT 1 FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = $1 AND t.typname = $2';
        const res = await client.query(q, [schema, typeName]);
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'applied' : 'pending',
          details: res.rowCount && res.rowCount > 0
            ? `Type ${schema}.${typeName} exists`
            : `Type ${schema}.${typeName} not found`,
          verificationQuery: q,
        };
      }

      case 'ALTER TYPE ADD VALUE': {
        // objectName: schema.typeName/value
        const slashIdx = parsed.objectName.indexOf('/');
        if (slashIdx === -1) {
          return { ...base, status: 'manual_check', details: 'Could not parse enum value' };
        }
        const qualifiedType = parsed.objectName.substring(0, slashIdx);
        const enumValue = parsed.objectName.substring(slashIdx + 1);
        const [schema, typeName] = qualifiedType.split('.');
        const q = 'SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = $1 AND t.typname = $2 AND e.enumlabel = $3';
        const res = await client.query(q, [schema, typeName, enumValue]);
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'applied' : 'pending',
          details: res.rowCount && res.rowCount > 0
            ? `Enum value '${enumValue}' exists in ${schema}.${typeName}`
            : `Enum value '${enumValue}' not found in ${schema}.${typeName}`,
          verificationQuery: q,
        };
      }

      case 'ADD CONSTRAINT': {
        // objectName: schema.table/constraintName
        const slashIdx = parsed.objectName.indexOf('/');
        if (slashIdx === -1) {
          return { ...base, status: 'manual_check', details: 'Could not parse constraint name' };
        }
        const qualifiedTable = parsed.objectName.substring(0, slashIdx);
        const constraintName = parsed.objectName.substring(slashIdx + 1);
        const [schema, table] = qualifiedTable.split('.');
        const q = 'SELECT 1 FROM information_schema.table_constraints WHERE table_schema = $1 AND table_name = $2 AND constraint_name = $3';
        const res = await client.query(q, [schema, table, constraintName]);
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'applied' : 'pending',
          details: res.rowCount && res.rowCount > 0
            ? `Constraint ${constraintName} exists on ${schema}.${table}`
            : `Constraint ${constraintName} not found on ${schema}.${table}`,
          verificationQuery: q,
        };
      }

      case 'DROP CONSTRAINT': {
        const slashIdx = parsed.objectName.indexOf('/');
        if (slashIdx === -1) {
          return { ...base, status: 'manual_check', details: 'Could not parse constraint name' };
        }
        const qualifiedTable = parsed.objectName.substring(0, slashIdx);
        const constraintName = parsed.objectName.substring(slashIdx + 1);
        const [schema, table] = qualifiedTable.split('.');
        const q = 'SELECT 1 FROM information_schema.table_constraints WHERE table_schema = $1 AND table_name = $2 AND constraint_name = $3';
        const res = await client.query(q, [schema, table, constraintName]);
        return {
          ...base,
          status: res.rowCount && res.rowCount > 0 ? 'pending' : 'applied',
          details: res.rowCount && res.rowCount > 0
            ? `Constraint ${constraintName} still exists on ${schema}.${table} (drop pending)`
            : `Constraint ${constraintName} not found on ${schema}.${table} (drop applied)`,
          verificationQuery: q,
        };
      }

      case 'INSERT':
        return { ...base, status: 'manual_check', details: 'INSERT statements require manual verification' };

      case 'UPDATE':
        return { ...base, status: 'manual_check', details: 'UPDATE statements require manual verification' };

      case 'DELETE':
        return { ...base, status: 'manual_check', details: 'DELETE statements require manual verification' };

      case 'UNKNOWN':
        return { ...base, status: 'manual_check', details: 'Unrecognized statement type — manual check needed' };

      default:
        return { ...base, status: 'skipped', details: `Operation "${parsed.operation}" skipped` };
    }
  } catch (err: any) {
    logger.error('Verification query failed', {
      operation: parsed.operation,
      objectName: parsed.objectName,
      error: err.message,
    });
    return {
      ...base,
      status: 'error',
      details: `Verification error: ${err.message}`,
    };
  }
}
