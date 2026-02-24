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
      /^\s*GRANT/i,
      /^\s*REVOKE/i,
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
    }

    if (dangerousOperations.length > 0) {
      return dangerousOperations.join(', ');
    }

    return null;
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
   * Split query into individual statements
   */
  public splitStatements(query: string): string[] {
    // Remove comments first
    const cleanQuery = query
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    // Split by semicolons, but handle BEGIN/END blocks carefully
    const statements: string[] = [];
    let currentStatement = '';
    let inBlock = false;

    const lines = cleanQuery.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Skip empty lines
      if (!trimmedLine) continue;

      // Check for block start (PL/pgSQL blocks, DO statements, etc.)
      // Match DO $$ blocks and standalone BEGIN (PL/pgSQL), but NOT transaction BEGIN; (ends with semicolon)
      if (/^\s*DO\s+\$/i.test(trimmedLine) || (/^\s*BEGIN\s*$/i.test(trimmedLine))) {
        inBlock = true;
      }

      // Check for block end
      if (inBlock && /^\s*(END|EXCEPTION)/i.test(trimmedLine)) {
        inBlock = false;
      }

      currentStatement += line + '\n';

      // Only split on semicolon if we're not inside a block
      if (!inBlock && trimmedLine.endsWith(';')) {
        const trimmed = currentStatement.trim();
        if (trimmed) {
          statements.push(trimmed);
        }
        currentStatement = '';
      }
    }

    // Handle last statement without semicolon
    const trimmed = currentStatement.trim();
    if (trimmed) {
      statements.push(trimmed);
    }

    // If no statements found, treat entire query as one statement
    if (statements.length === 0 && cleanQuery.trim()) {
      statements.push(cleanQuery.trim());
    }

    return statements;
  }
}

export default new QueryValidator();
