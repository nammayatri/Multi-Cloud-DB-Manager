import { PoolClient } from 'pg';
import logger from '../../utils/logger';
import { MigrationStatement } from '../../types/migrations';
import { ParsedStatement } from './sql-parser.service';

/**
 * Verify whether a single parsed SQL statement has been applied to the database.
 * Uses only parameterized queries against information_schema / pg_catalog.
 */
export async function verifyStatement(
  client: PoolClient,
  parsed: ParsedStatement,
  defaultSchema: string
): Promise<MigrationStatement> {
  const base: MigrationStatement = {
    sql: parsed.sql,
    type: parsed.type,
    operation: parsed.operation,
    objectName: parsed.objectName,
    status: 'manual_check',
    details: '',
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
        const q = 'SELECT data_type, udt_name, character_maximum_length, numeric_precision FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3';
        const res = await client.query(q, [schema, table, column]);
        if (!res.rowCount || res.rowCount === 0) {
          return { ...base, status: 'pending', details: `Column ${column} not found in ${schema}.${table}`, verificationQuery: q };
        }
        const row = res.rows[0];
        const currentUdt = (row.udt_name || '').toLowerCase();
        const currentDataType = (row.data_type || '').toLowerCase();

        if (!targetType) {
          return { ...base, status: 'manual_check', details: `Column ${column} current type: ${currentUdt} — could not parse target type`, verificationQuery: q };
        }

        // Normalize common PostgreSQL type aliases for comparison
        const typeAliases: Record<string, string[]> = {
          'int4': ['integer', 'int', 'int4'],
          'int8': ['bigint', 'int8'],
          'int2': ['smallint', 'int2'],
          'float8': ['double precision', 'float8'],
          'float4': ['real', 'float4'],
          'bool': ['boolean', 'bool'],
          'varchar': ['character varying', 'varchar'],
          'text': ['text'],
          'timestamptz': ['timestamp with time zone', 'timestamptz'],
          'timestamp': ['timestamp without time zone', 'timestamp'],
        };

        function typesMatch(current: string, target: string): boolean {
          const normTarget = target.replace(/\s*\(\d+\)\s*$/, '').trim();
          if (current === normTarget) return true;
          for (const [canonical, aliases] of Object.entries(typeAliases)) {
            const allNames = [canonical, ...aliases];
            if (allNames.includes(current) && allNames.includes(normTarget)) return true;
          }
          return false;
        }

        const matched = typesMatch(currentUdt, targetType) || typesMatch(currentDataType, targetType);
        return {
          ...base,
          status: matched ? 'applied' : 'pending',
          details: matched
            ? `Column ${column} type is ${currentUdt} (matches ${targetType})`
            : `Column ${column} type is ${currentUdt}, expected ${targetType}`,
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
