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
export function parseSchemaQualifiedName(raw: string, defaultSchema: string): [string, string] {
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

  // -- DO $$ blocks and CREATE [OR REPLACE] FUNCTION — treat as opaque procedural code --
  if (/^\s*DO\s+\$/i.test(clean) || /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i.test(clean)) {
    return { sql, type: 'OTHER', operation: 'UNKNOWN', objectName: 'manual_check' };
  }

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

/**
 * Canonical form of a SQL statement for identity comparison between two file
 * versions: lowercased, whitespace collapsed, trailing semicolons removed. Two
 * statements with the same canonical form are the "same" migration line, so
 * cosmetic reformatting between refs is not mistaken for a new statement.
 */
export function canonicalizeStatement(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')       // strip line comments
    .replace(/\s+/g, ' ')
    .replace(/;+\s*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Statements ADDED in `toRef` relative to `baseContent` — i.e. present in the
 * new file version but not the old one. This scopes analysis to the migrations
 * THIS diff introduced, instead of re-checking every (often years-old)
 * statement in the whole current file.
 */
export function addedStatements(toStatements: string[], baseContent: string): string[] {
  const baseSet = new Set(splitStatements(baseContent).map(canonicalizeStatement));
  return toStatements.filter(s => !baseSet.has(canonicalizeStatement(s)));
}

/**
 * Strip everything that can contain a dot but is not an identifier: line and
 * block comments, single-quoted literals, and dollar-quoted bodies. Without
 * this, `SET note = 'v1.2.3'` or a function body mentioning `other.tbl` would
 * be mistaken for the statement's target.
 */
function stripNonIdentifierText(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Dollar quoting must go before single quotes: a $$ body may contain them.
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1?\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, " '' ");
}

/**
 * The schema a statement targets, or null when it names no schema.
 *
 * `classifyStatement` already resolves this for the shapes it models, but it
 * reports the literal 'manual_check'/'skipped' for the rest — DROP TABLE,
 * ALTER ... RENAME, CREATE FUNCTION/VIEW and friends — which is precisely where
 * the lite runner rescues real DDL. It also substitutes its defaultSchema for
 * unqualified names, so an unqualified statement becomes indistinguishable from
 * an explicitly-qualified one. This resolves the schema independently of both
 * problems, and returns null (rather than a default) so the caller can decide
 * what an unqualified statement means.
 *
 * Heuristic: the FIRST schema-qualified identifier in the statement. That is
 * the target for every shape that matters — `ALTER TABLE s.t ...`,
 * `INSERT INTO s.t SELECT ... FROM other.x`, and `CREATE INDEX i ON s.t (...)`
 * (the index name carries no qualifier, so the ON table wins).
 */
export function extractSchema(sql: string): string | null {
  const clean = stripNonIdentifierText(sql);

  // Anchored on a boundary and an identifier start character so numeric
  // literals (0.5), type modifiers (numeric(10, 2)) and casts (c::text) cannot
  // match. The `\.\s*` requires a real qualifier, not a lone identifier.
  const match = clean.match(
    /(?:^|[\s(,;=])("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/
  );
  if (!match) return null;

  const [schema] = parseSchemaQualifiedName(`${match[1]}.${match[2]}`, '');
  return schema || null;
}
