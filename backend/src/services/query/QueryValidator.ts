import logger from '../../utils/logger';

/**
 * QueryValidator - Handles SQL query validation and safety checks
 */
export class QueryValidator {
  /**
   * Validate SQL query (basic validation)
   */
  public validateQuery(query: string): { valid: boolean; error?: string } {
    // Remove comments and whitespace
    const cleanQuery = query
      .replace(/--.*$/gm, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
      .trim();

    if (!cleanQuery) {
      return { valid: false, error: 'Query is empty' };
    }

    // Block only system-level operations that should never be allowed
    // Note: Table-level operations (DROP TABLE, TRUNCATE, DELETE, ALTER) are allowed
    // but will require password verification in the controller
    const absolutelyBlockedPatterns = [
      /^\s*DROP\s+DATABASE/i,
      /^\s*DROP\s+SCHEMA/i,
      /^\s*CREATE\s+DATABASE/i,
      /^\s*CREATE\s+SCHEMA/i,
      /^\s*ALTER\s+ROLE/i,
      /^\s*ALTER\s+USER/i,
      /^\s*CREATE\s+ROLE/i,
      /^\s*CREATE\s+USER/i,
      /^\s*DROP\s+ROLE/i,
      /^\s*DROP\s+USER/i,
    ];

    for (const pattern of absolutelyBlockedPatterns) {
      if (pattern.test(cleanQuery)) {
        return {
          valid: false,
          error: 'This operation is not allowed for safety reasons',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Check if a single statement is a CREATE INDEX without CONCURRENTLY.
   * These take strong locks and should be blocked — but per-statement so batches can continue.
   */
  public isNonConcurrentCreateIndex(statement: string): boolean {
    const clean = statement
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    return /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(clean) &&
           !/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(clean);
  }

  /**
   * Check if query requires password verification
   * Returns the operation type if verification is required, null otherwise
   */
  public requiresPasswordVerification(query: string): string | null {
    // Remove comments and whitespace
    const cleanQuery = query
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .toUpperCase();

    // Split by semicolons to check all statements
    const statements = cleanQuery.split(';').map(s => s.trim()).filter(s => s);

    const dangerousOperations: string[] = [];

    for (const statement of statements) {
      // Check for DROP operations (excluding DROP INDEX which is sometimes needed)
      if (/^\s*DROP\s+/i.test(statement)) {
        // Allow DROP INDEX without password
        if (!/^\s*DROP\s+INDEX/i.test(statement)) {
          dangerousOperations.push('DROP');
        }
      }

      // Check for TRUNCATE
      if (/^\s*TRUNCATE\s+/i.test(statement)) {
        dangerousOperations.push('TRUNCATE');
      }

      // Check for DELETE without WHERE clause
      if (/^\s*DELETE\s+FROM/i.test(statement) && !/WHERE/i.test(statement)) {
        dangerousOperations.push('DELETE without WHERE');
      }

      // Check for ALTER operations (excluding ALTER ADD which is safe)
      if (/^\s*ALTER\s+/i.test(statement)) {
        // ALTER ADD is considered safe (adding columns, indexes, constraints)
        // ALTER DROP is dangerous (dropping columns, constraints)
        if (/\s+DROP\s+/i.test(statement)) {
          dangerousOperations.push('ALTER DROP');
        }
      }

      // GRANT / REVOKE require password (MASTER only via role middleware)
      if (/^\s*GRANT\s+/i.test(statement)) {
        dangerousOperations.push('GRANT');
      }
      if (/^\s*REVOKE\s+/i.test(statement)) {
        dangerousOperations.push('REVOKE');
      }

    }

    if (dangerousOperations.length > 0) {
      return dangerousOperations.join(', ');
    }

    return null;
  }

  /**
   * Extract target table names from CREATE INDEX statements in the query.
   * Returns array of fully-qualified table names (schema.table) if schema given, else just table.
   */
  public extractCreateIndexTables(query: string, defaultSchema?: string): string[] {
    const cleanQuery = query
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const statements = cleanQuery.split(';').map(s => s.trim()).filter(s => s);
    const tables: string[] = [];

    for (const stmt of statements) {
      // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] <index_name> ON [schema.]table
      const match = stmt.match(
        /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\s+ON\s+(?:ONLY\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)/i
      );
      if (match) {
        const raw = match[1].replace(/"/g, '').replace(/\s+/g, '').toLowerCase();
        if (raw.includes('.')) {
          tables.push(raw);
        } else if (defaultSchema) {
          tables.push(`${defaultSchema.toLowerCase()}.${raw}`);
        } else {
          tables.push(raw);
        }
      }
    }

    return tables;
  }

  /**
   * Check if a CREATE INDEX query targets any protected tables.
   * Returns the list of matched protected tables, or empty array if none.
   */
  public checkIndexCreateBlocked(
    query: string,
    blockedTables: string[] | undefined,
    defaultSchema?: string
  ): string[] {
    if (!blockedTables || blockedTables.length === 0) return [];

    const targetTables = this.extractCreateIndexTables(query, defaultSchema);
    if (targetTables.length === 0) return [];

    const normalizedBlocked = blockedTables.map(t => t.toLowerCase());
    return targetTables.filter(t => normalizedBlocked.includes(t));
  }

  /**
   * Validate pgSchema name to prevent SQL injection
   * Only allows alphanumeric characters, underscores, and hyphens
   * Must start with letter or underscore (PostgreSQL identifier rules)
   */
  public validateSchemaName(pgSchema: string): { valid: boolean; error?: string } {
    // PostgreSQL identifier rules:
    // - Must start with letter or underscore
    // - Can contain letters, numbers, underscores
    // - Maximum length 63 bytes
    if (!pgSchema || typeof pgSchema !== 'string') {
      return {
        valid: false,
        error: 'Schema name is required',
      };
    }
    
    if (pgSchema.length > 63) {
      return {
        valid: false,
        error: `Schema name too long: ${pgSchema.length} characters (max 63)`,
      };
    }
    
    // Must start with letter or underscore
    if (!/^[a-zA-Z_]/.test(pgSchema)) {
      return {
        valid: false,
        error: `Invalid schema name: ${pgSchema}. Schema names must start with a letter or underscore.`,
      };
    }
    
    // Only allow alphanumeric and underscores (no hyphens in SQL identifiers without quotes)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pgSchema)) {
      return {
        valid: false,
        error: `Invalid schema name: ${pgSchema}. Schema names can only contain letters, numbers, and underscores.`,
      };
    }
    
    return { valid: true };
  }

  /**
   * Check if a statement is a transaction control statement
   */
  public isTransactionStatement(statement: string): boolean {
    const upper = statement.trim().toUpperCase();
    return (
      upper.startsWith('BEGIN') ||
      upper.startsWith('START TRANSACTION') ||
      upper.startsWith('COMMIT') ||
      upper.startsWith('ROLLBACK') ||
      upper.startsWith('SAVEPOINT') ||
      upper.startsWith('RELEASE') ||
      upper.startsWith('ABORT')
    );
  }

  /**
   * Auto-append LIMIT to SELECT statements that don't already have one.
   * Handles plain SELECT, CTEs (WITH ... SELECT), and skips non-SELECT statements.
   */
  public addDefaultLimit(statement: string, limit: number = 10): string {
    // Strip comments for analysis but keep original for modification
    const clean = statement
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();

    const upper = clean.toUpperCase();

    // Only apply to SELECT or WITH...SELECT (CTE) queries
    const isSelect = upper.startsWith('SELECT') || upper.startsWith('WITH');
    if (!isSelect) return statement;

    // Skip if it's a SELECT INTO or INSERT ... SELECT
    if (/^\s*SELECT\s+.*\s+INTO\s+/i.test(clean)) return statement;

    // Already has LIMIT — don't touch it
    // Match LIMIT at the end, possibly followed by OFFSET, trailing semicolons/whitespace
    if (/LIMIT\s+\d+/i.test(clean)) return statement;

    // Remove trailing semicolon, add LIMIT, put semicolon back
    const trimmed = statement.replace(/;\s*$/, '').trimEnd();
    const hadSemicolon = /;\s*$/.test(statement);
    return trimmed + ` LIMIT ${limit}` + (hadSemicolon ? ';' : '');
  }

  /**
   * Split query into individual statements.
   * Handles dollar-quoted strings ($$...$$, $tag$...$tag$), single-quoted strings,
   * and SQL comments so that semicolons inside string literals or function bodies
   * are never treated as statement separators.
   */
  public splitStatements(query: string): string[] {
    const statements: string[] = [];
    let current = '';
    let i = 0;

    // State
    let inSingleQuote = false;
    let dollarTag: string | null = null; // null = not in dollar-quote; '' = $$; 'tag' = $tag$

    while (i < query.length) {
      const ch = query[i];

      // ── Inside a single-quoted string ────────────────────────────────
      if (inSingleQuote) {
        if (ch === "'" && query[i + 1] === "'") {
          // Escaped quote ('') — consume both
          current += "''";
          i += 2;
        } else if (ch === "'") {
          current += ch;
          inSingleQuote = false;
          i++;
        } else {
          current += ch;
          i++;
        }
        continue;
      }

      // ── Inside a dollar-quoted string ────────────────────────────────
      if (dollarTag !== null) {
        const closeTag = `$${dollarTag}$`;
        if (query.startsWith(closeTag, i)) {
          current += closeTag;
          i += closeTag.length;
          dollarTag = null;
        } else {
          current += ch;
          i++;
        }
        continue;
      }

      // ── Outside any string literal ────────────────────────────────────

      // Single-line comment — skip to end of line
      if (ch === '-' && query[i + 1] === '-') {
        const nl = query.indexOf('\n', i);
        if (nl === -1) { i = query.length; } else { i = nl + 1; }
        continue;
      }

      // Block comment — skip to */
      if (ch === '/' && query[i + 1] === '*') {
        const end = query.indexOf('*/', i + 2);
        if (end === -1) { i = query.length; } else { i = end + 2; }
        continue;
      }

      // Enter single-quoted string
      if (ch === "'") {
        inSingleQuote = true;
        current += ch;
        i++;
        continue;
      }

      // Enter dollar-quoted string — match $tag$ pattern
      if (ch === '$') {
        const rest = query.slice(i);
        const match = rest.match(/^\$([^$\s]*)\$/);
        if (match) {
          dollarTag = match[1]; // '' for $$, or the tag name
          current += match[0];
          i += match[0].length;
          continue;
        }
      }

      // Statement separator
      if (ch === ';') {
        current += ch;
        const trimmed = current.trim();
        if (trimmed) statements.push(trimmed);
        current = '';
        i++;
        continue;
      }

      current += ch;
      i++;
    }

    // Trailing statement without semicolon
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);

    return statements;
  }
}

export default new QueryValidator();
