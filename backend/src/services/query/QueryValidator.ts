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
   * Strip single-quoted string literals (replaces them with empty literal '').
   * Used to avoid keyword false-positives inside DEFAULT 'NOT NULL' style values.
   */
  private stripSingleQuotedStrings(text: string): string {
    return text.replace(/'(?:''|[^'])*'/g, "''");
  }

  /**
   * Check if an ADD COLUMN action declares NOT NULL without a DEFAULT (and no GENERATED clause).
   * Such columns force a full table rewrite under AccessExclusiveLock — banned for RELEASE_MANAGER.
   *
   * Only flags the explicit NOT NULL keyword. Implicit NOT NULL via PRIMARY KEY is intentionally
   * allowed.
   */
  public hasNotNullWithoutDefault(actionText: string): boolean {
    const stripped = this.stripSingleQuotedStrings(actionText);
    if (!/\bNOT\s+NULL\b/i.test(stripped)) return false;
    if (/\bDEFAULT\b/i.test(stripped)) return false;
    if (/\bGENERATED\b/i.test(stripped)) return false;
    return true;
  }

  /**
   * Split the actions clause of an ALTER TABLE statement on commas at paren-depth 0,
   * ignoring commas inside parentheses (CHECK expressions, type modifiers like NUMERIC(10,2),
   * IN-list checks, etc.) and inside single-quoted string literals.
   */
  public splitAlterTableActions(actionsText: string): string[] {
    const actions: string[] = [];
    let current = '';
    let parenDepth = 0;
    let inSingleQuote = false;
    let i = 0;
    while (i < actionsText.length) {
      const ch = actionsText[i];
      if (inSingleQuote) {
        current += ch;
        if (ch === "'" && actionsText[i + 1] === "'") {
          current += "'";
          i += 2;
          continue;
        }
        if (ch === "'") inSingleQuote = false;
        i++;
        continue;
      }
      if (ch === "'") { inSingleQuote = true; current += ch; i++; continue; }
      if (ch === '(') { parenDepth++; current += ch; i++; continue; }
      if (ch === ')') { parenDepth--; current += ch; i++; continue; }
      if (ch === ',' && parenDepth === 0) {
        const t = current.trim();
        if (t) actions.push(t);
        current = '';
        i++;
        continue;
      }
      current += ch;
      i++;
    }
    const t = current.trim();
    if (t) actions.push(t);
    return actions;
  }

  /**
   * Extract the actions text from an ALTER TABLE statement (text after the table name).
   * Returns null if the statement does not match the expected ALTER TABLE shape.
   */
  public extractAlterTableActionsText(stmt: string): string | null {
    const clean = stmt
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .replace(/;\s*$/, '');
    const m = clean.match(
      /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\s*\.\s*"?[a-zA-Z_][a-zA-Z0-9_]*"?)?)\s+([\s\S]+)$/i
    );
    if (!m) return null;
    return m[1].trim();
  }

  /**
   * Decide whether a single statement is allowed for the RELEASE_MANAGER role.
   * Allowlist:
   *   - SELECT / WITH (CTE) / EXPLAIN / SHOW (read-only)
   *   - Transaction control (BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE / ABORT)
   *   - CREATE [UNIQUE] INDEX CONCURRENTLY ...
   *   - ALTER TABLE ... ADD COLUMN ... (must NOT be NOT NULL without DEFAULT/GENERATED)
   *   - ALTER TABLE ... ADD CONSTRAINT ... (or ADD CHECK/UNIQUE/PRIMARY KEY/FOREIGN KEY/EXCLUDE)
   * Anything else → blocked.
   */
  public isAllowedForReleaseManager(statement: string): { allowed: boolean; reason?: string } {
    const clean = statement
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    if (!clean) return { allowed: true };

    if (this.isTransactionStatement(clean)) return { allowed: true };

    if (/^\s*(SELECT|WITH|EXPLAIN|SHOW)\b/i.test(clean)) {
      // SELECT INTO creates a new table — treat as a write
      if (/^\s*SELECT\b[\s\S]*?\sINTO\s+(?!STRICT\b)/i.test(clean)) {
        return {
          allowed: false,
          reason: 'SELECT INTO creates a new table and is not allowed for RELEASE_MANAGER',
        };
      }
      return { allowed: true };
    }

    if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(clean)) {
      if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(clean)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'RELEASE_MANAGER may only create indexes with CONCURRENTLY',
      };
    }

    // CREATE TABLE (incl. TEMP/TEMPORARY/UNLOGGED, optional GLOBAL/LOCAL).
    // Inline NOT NULL is fine on a brand-new table (no rewrite, no existing rows).
    // CREATE TABLE AS / CREATE TABLE ... LIKE ... also covered by this branch.
    if (/^\s*CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?TABLE\b/i.test(clean)) {
      return { allowed: true };
    }

    if (/^\s*ALTER\s+TABLE\b/i.test(clean)) {
      const actionsText = this.extractAlterTableActionsText(clean);
      if (!actionsText) {
        return { allowed: false, reason: 'Could not parse ALTER TABLE statement' };
      }
      const actions = this.splitAlterTableActions(actionsText);
      if (actions.length === 0) {
        return { allowed: false, reason: 'ALTER TABLE has no actions' };
      }
      for (const action of actions) {
        const result = this.classifyAlterTableActionForReleaseManager(action);
        if (!result.allowed) return result;
      }
      return { allowed: true };
    }

    return {
      allowed: false,
      reason:
        'RELEASE_MANAGER may only run SELECT / EXPLAIN, CREATE TABLE, CREATE INDEX CONCURRENTLY, ALTER TABLE ADD COLUMN/CONSTRAINT, or transaction commands',
    };
  }

  private classifyAlterTableActionForReleaseManager(action: string): { allowed: boolean; reason?: string } {
    const trimmed = action.trim();
    const upper = trimmed.toUpperCase();

    if (!/^ADD(\s|$)/.test(upper)) {
      return {
        allowed: false,
        reason: `RELEASE_MANAGER may only ADD COLUMN or ADD CONSTRAINT in ALTER TABLE — got: ${trimmed.substring(0, 80)}`,
      };
    }

    const rest = trimmed.replace(/^\s*ADD\s+/i, '');
    const upperRest = rest.toUpperCase();

    const constraintStarts = [
      'CONSTRAINT ', 'CONSTRAINT\t', 'CONSTRAINT\n',
      'CHECK ', 'CHECK(',
      'UNIQUE ', 'UNIQUE(',
      'PRIMARY KEY ', 'PRIMARY KEY(',
      'FOREIGN KEY ', 'FOREIGN KEY(',
      'EXCLUDE ', 'EXCLUDE(',
    ];
    if (constraintStarts.some(s => upperRest.startsWith(s))) {
      return { allowed: true };
    }

    let colDef = rest.replace(/^\s*COLUMN\s+/i, '');
    colDef = colDef.replace(/^\s*IF\s+NOT\s+EXISTS\s+/i, '');

    if (this.hasNotNullWithoutDefault(colDef)) {
      return {
        allowed: false,
        reason:
          'ADD COLUMN with NOT NULL must include a DEFAULT — otherwise PostgreSQL rewrites the table under AccessExclusiveLock and blocks all writes',
      };
    }
    return { allowed: true };
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
