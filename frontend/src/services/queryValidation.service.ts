export interface ValidationWarning {
  type: 'danger' | 'warning';
  title: string;
  message: string;
  affectedStatements: string[];
}

/**
 * Detects dangerous SQL queries that could cause data loss
 */
export const detectDangerousQueries = (query: string): ValidationWarning | null => {
  // Normalize query: remove comments and extra whitespace
  const normalizedQuery = query
    .replace(/--.*$/gm, '') // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  // Split by semicolons to handle multiple statements
  const statements = normalizedQuery
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const dangerousStatements: string[] = [];
  let warningType: 'danger' | 'warning' = 'warning';
  let warningTitle = '';
  let warningMessage = '';

  for (const statement of statements) {
    const upperStatement = statement.toUpperCase();

    // Check for DROP TABLE/DATABASE
    if (upperStatement.match(/^\s*DROP\s+(TABLE|DATABASE|SCHEMA)/i)) {
      dangerousStatements.push(statement);
      warningType = 'danger';
      warningTitle = 'DROP Statement Detected';
      warningMessage = 'This will permanently delete the table/database/schema and all its data. This action cannot be undone!';
    }

    // Check for TRUNCATE
    else if (upperStatement.match(/^\s*TRUNCATE\s+/i)) {
      dangerousStatements.push(statement);
      warningType = 'danger';
      warningTitle = 'TRUNCATE Statement Detected';
      warningMessage = 'This will delete ALL rows from the table(s). This action cannot be undone!';
    }

    // Check for DELETE without WHERE
    else if (upperStatement.match(/^\s*DELETE\s+FROM\s+/i)) {
      // Check if WHERE clause exists
      if (!upperStatement.match(/\s+WHERE\s+/i)) {
        dangerousStatements.push(statement);
        warningType = 'danger';
        warningTitle = 'DELETE Without WHERE Clause';
        warningMessage = 'This will delete ALL rows from the table! Did you forget the WHERE clause?';
      }
    }

    // Check for UPDATE without WHERE
    else if (upperStatement.match(/^\s*UPDATE\s+/i)) {
      // Check if WHERE clause exists
      if (!upperStatement.match(/\s+WHERE\s+/i)) {
        dangerousStatements.push(statement);
        warningType = 'danger';
        warningTitle = 'UPDATE Without WHERE Clause';
        warningMessage = 'This will update ALL rows in the table! Did you forget the WHERE clause?';
      }
    }
  }

  if (dangerousStatements.length > 0) {
    return {
      type: warningType,
      title: warningTitle,
      message: warningMessage,
      affectedStatements: dangerousStatements,
    };
  }

  return null;
};
