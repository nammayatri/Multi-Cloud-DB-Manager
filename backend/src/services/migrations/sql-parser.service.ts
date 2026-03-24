import { QueryValidator } from '../query/QueryValidator';

const validator = new QueryValidator();

export interface ParsedStatement {
  sql: string;
  type: 'DDL' | 'DML' | 'OTHER';
  operation: string;
  objectName: string;
}

/**
 * Split SQL text into individual statements, reusing the existing QueryValidator logic.
 */
export function splitStatements(sql: string): string[] {
  return validator.splitStatements(sql);
}

/**
 * Extract schema and name from a potentially quoted identifier like "schema"."table" or schema.table.
 * Returns [schema, name]. If no schema prefix, uses defaultSchema.
 */
function parseSchemaQualifiedName(raw: string, defaultSchema: string): [string, string] {
  // Remove surrounding whitespace
  raw = raw.trim();

  // Handle "schema"."name" or "schema".name
  const quotedMatch = raw.match(/^"([^"]+)"\s*\.\s*"?([^"]+)"?$/);
  if (quotedMatch) {
    return [quotedMatch[1], quotedMatch[2]];
  }

  // Handle schema."name"
  const mixedMatch = raw.match(/^([^".\s]+)\s*\.\s*"([^"]+)"$/);
  if (mixedMatch) {
    return [mixedMatch[1], mixedMatch[2]];
  }

  // Handle schema.name (unquoted)
  const parts = raw.split('.');
  if (parts.length >= 2) {
    return [parts[0].replace(/"/g, ''), parts[1].replace(/"/g, '')];
  }

  // No schema prefix
  return [defaultSchema, raw.replace(/"/g, '')];
}

/**
 * Extract just the name from a potentially quoted identifier (no schema expected).
 */
function unquote(name: string): string {
  return name.trim().replace(/^"/, '').replace(/"$/, '');
}

/**
 * Classify a single SQL statement into type, operation, and objectName.
 */
export function classifyStatement(sql: string, defaultSchema: string): ParsedStatement {
  // Strip comments for classification
  const clean = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  const upper = clean.toUpperCase();

  // -- CREATE TABLE --
  const createTableMatch = clean.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)/i
  );
  if (createTableMatch) {
    const [schema, table] = parseSchemaQualifiedName(createTableMatch[1], defaultSchema);
    return { sql, type: 'DDL', operation: 'CREATE TABLE', objectName: `${schema}.${table}` };
  }

  // -- ALTER TABLE ... ADD PRIMARY KEY (shorthand, no named constraint) --
  const addPkMatch = clean.match(
    /ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS|ONLY)\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+ADD\s+PRIMARY\s+KEY\s*\(/i
  );
  if (addPkMatch) {
    const [schema, table] = parseSchemaQualifiedName(addPkMatch[1], defaultSchema);
    return { sql, type: 'DDL', operation: 'ADD CONSTRAINT', objectName: `${schema}.${table}/${table}_pkey` };
  }

  // -- ALTER TABLE ... ADD CONSTRAINT --
  const addConstraintMatch = clean.match(
    /ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS|ONLY)\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+ADD\s+CONSTRAINT\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)/i
  );
  if (addConstraintMatch) {
    const [schema, table] = parseSchemaQualifiedName(addConstraintMatch[1], defaultSchema);
    const constraint = unquote(addConstraintMatch[2]);
    return { sql, type: 'DDL', operation: 'ADD CONSTRAINT', objectName: `${schema}.${table}/${constraint}` };
  }

  // -- ALTER TABLE ... DROP CONSTRAINT --
  const dropConstraintMatch = clean.match(
    /ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS|ONLY)\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)/i
  );
  if (dropConstraintMatch) {
    const [schema, table] = parseSchemaQualifiedName(dropConstraintMatch[1], defaultSchema);
    const constraint = unquote(dropConstraintMatch[2]);
    return { sql, type: 'DDL', operation: 'DROP CONSTRAINT', objectName: `${schema}.${table}/${constraint}` };
  }

  // -- ALTER TABLE ... OWNER TO --
  if (/ALTER\s+TABLE\s+.*\s+OWNER\s+TO/i.test(clean)) {
    return { sql, type: 'DDL', operation: 'OWNER', objectName: 'skipped' };
  }

  // -- ALTER TABLE ... ADD [COLUMN] --
  const addColMatch = clean.match(
    /ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS|ONLY)\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s+/i
  );
  if (addColMatch) {
    const [schema, table] = parseSchemaQualifiedName(addColMatch[1], defaultSchema);
    const col = unquote(addColMatch[2]);
    return { sql, type: 'DDL', operation: 'ADD COLUMN', objectName: `${schema}.${table}.${col}` };
  }

  // -- ALTER TABLE ... DROP [COLUMN] --
  const dropColMatch = clean.match(
    /ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS|ONLY)\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)/i
  );
  if (dropColMatch) {
    const [schema, table] = parseSchemaQualifiedName(dropColMatch[1], defaultSchema);
    const col = unquote(dropColMatch[2]);
    return { sql, type: 'DDL', operation: 'DROP COLUMN', objectName: `${schema}.${table}.${col}` };
  }

  // -- ALTER TABLE ... ALTER [COLUMN] ... TYPE --
  const alterColTypeMatch = clean.match(
    /ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS|ONLY)\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+ALTER\s+(?:COLUMN\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s+(?:SET\s+DATA\s+)?TYPE\s+(.+?)(?:\s+USING|\s*;?\s*$)/i
  );
  if (alterColTypeMatch) {
    const [schema, table] = parseSchemaQualifiedName(alterColTypeMatch[1], defaultSchema);
    const col = unquote(alterColTypeMatch[2]);
    const targetType = alterColTypeMatch[3].trim().replace(/;$/, '').trim().toLowerCase();
    // Store target type after / separator: schema.table.col/targetType
    return { sql, type: 'DDL', operation: 'ALTER COLUMN TYPE', objectName: `${schema}.${table}.${col}/${targetType}` };
  }

  // -- ALTER TABLE ... ALTER [COLUMN] ... (SET|DROP) (DEFAULT|NOT NULL) --
  const alterColMatch = clean.match(
    /ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS|ONLY)\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+ALTER\s+(?:COLUMN\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s+(?:SET|DROP)\s+/i
  );
  if (alterColMatch) {
    const [schema, table] = parseSchemaQualifiedName(alterColMatch[1], defaultSchema);
    const col = unquote(alterColMatch[2]);
    return { sql, type: 'DDL', operation: 'ALTER COLUMN', objectName: `${schema}.${table}.${col}` };
  }

  // -- CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON ... --
  const createIndexMatch = clean.match(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s+ON\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)/i
  );
  if (createIndexMatch) {
    const indexName = unquote(createIndexMatch[1]);
    const [schema] = parseSchemaQualifiedName(createIndexMatch[2], defaultSchema);
    return { sql, type: 'DDL', operation: 'CREATE INDEX', objectName: `${schema}.${indexName}` };
  }

  // -- DROP INDEX [CONCURRENTLY] [IF EXISTS] [schema.]name --
  const dropIndexMatch = clean.match(
    /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)/i
  );
  if (dropIndexMatch) {
    const [schema, name] = parseSchemaQualifiedName(dropIndexMatch[1], defaultSchema);
    return { sql, type: 'DDL', operation: 'DROP INDEX', objectName: `${schema}.${name}` };
  }

  // -- CREATE TYPE ... AS ENUM --
  const createTypeMatch = clean.match(
    /CREATE\s+TYPE\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+AS\s+ENUM/i
  );
  if (createTypeMatch) {
    const [schema, name] = parseSchemaQualifiedName(createTypeMatch[1], defaultSchema);
    return { sql, type: 'DDL', operation: 'CREATE TYPE', objectName: `${schema}.${name}` };
  }

  // -- ALTER TYPE ... ADD VALUE --
  const alterTypeMatch = clean.match(
    /ALTER\s+TYPE\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/i
  );
  if (alterTypeMatch) {
    const [schema, name] = parseSchemaQualifiedName(alterTypeMatch[1], defaultSchema);
    const value = alterTypeMatch[2];
    return { sql, type: 'DDL', operation: 'ALTER TYPE ADD VALUE', objectName: `${schema}.${name}/${value}` };
  }

  // -- INSERT INTO --
  if (/^\s*INSERT\s+INTO/i.test(clean)) {
    const insertMatch = clean.match(
      /INSERT\s+INTO\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)/i
    );
    const objectName = insertMatch
      ? parseSchemaQualifiedName(insertMatch[1], defaultSchema).join('.')
      : 'unknown';
    return { sql, type: 'DML', operation: 'INSERT', objectName };
  }

  // -- UPDATE --
  if (/^\s*UPDATE\s+/i.test(clean)) {
    return { sql, type: 'DML', operation: 'UPDATE', objectName: 'manual_check' };
  }

  // -- DELETE FROM --
  if (/^\s*DELETE\s+FROM/i.test(clean)) {
    return { sql, type: 'DML', operation: 'DELETE', objectName: 'manual_check' };
  }

  // -- GRANT / COMMENT ON / SET --
  if (/^\s*(GRANT|COMMENT\s+ON|SET\s+)/i.test(clean)) {
    return { sql, type: 'OTHER', operation: 'SKIPPED', objectName: 'skipped' };
  }

  // -- Anything else --
  return { sql, type: 'OTHER', operation: 'UNKNOWN', objectName: 'manual_check' };
}
