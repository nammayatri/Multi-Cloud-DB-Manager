import { isSuperRole, type Role } from '../constants/roles';

export interface ValidationWarning {
  type: 'danger' | 'warning';
  title: string;
  message: string;
  affectedStatements: string[];
  requiresPassword?: boolean;
}

/**
 * Detects dangerous SQL queries that could cause data loss.
 *
 * IMPORTANT: `requiresPassword` must stay aligned with the backend's
 * QueryValidator.requiresPasswordVerification(), which demands a password for:
 *   - DROP …            (any object EXCEPT `DROP INDEX`)
 *   - TRUNCATE …
 *   - DELETE FROM … without WHERE
 *   - ALTER … containing DROP (e.g. ALTER TABLE … DROP COLUMN)
 *   - GRANT … / REVOKE …
 * If the lists drift, the backend rejects with "Password verification required"
 * and DatabaseSelector re-opens this dialog as a safety net — but keeping them
 * aligned means the user is prompted up-front.
 *
 * @param query - SQL query to validate
 * @param userRole - Current user's role
 */
export const detectDangerousQueries = (
  query: string,
  userRole?: Role
): ValidationWarning | null => {
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
  let requiresPassword = false;
  // Only MASTER/ADMIN are ever prompted — other roles are rejected by the
  // backend before the password check applies.
  const isSuper = isSuperRole(userRole);

  for (const statement of statements) {
    const upperStatement = statement.toUpperCase();

    // DROP of any object. The backend requires a password for every DROP except
    // DROP INDEX (which is still worth a confirmation, just no password).
    if (upperStatement.match(/^\s*DROP\s+/i)) {
      const isDropIndex = /^\s*DROP\s+INDEX/i.test(upperStatement);
      dangerousStatements.push(statement);
      warningType = 'danger';
      warningTitle = 'DROP Statement Detected';
      warningMessage = userRole && !isSuperRole(userRole)
        ? '⛔ This operation requires MASTER/ADMIN role. This will permanently delete the object and all its data!'
        : 'This will permanently delete the object and all its data. This action cannot be undone!';
      if (!isDropIndex) requiresPassword = isSuper;
    }

    // TRUNCATE — always requires a password (MASTER).
    if (upperStatement.match(/^\s*TRUNCATE\s+/i)) {
      dangerousStatements.push(statement);
      warningType = 'danger';
      warningTitle = 'TRUNCATE Statement Detected';
      warningMessage = userRole && !isSuperRole(userRole)
        ? '⛔ This operation requires MASTER/ADMIN role. This will delete ALL rows from the table(s)!'
        : 'This will delete ALL rows from the table(s). This action cannot be undone!';
      requiresPassword = isSuper;
    }

    // ALTER (excluding plain ADD COLUMN/CONSTRAINT/INDEX, which is safe).
    // Only ALTER … DROP … needs a password on the backend.
    if (upperStatement.match(/^\s*ALTER\s+/i)) {
      const isAlterDrop = /\s+DROP\s+/i.test(upperStatement);
      if (isAlterDrop || !upperStatement.match(/\s+ADD\s+(COLUMN|CONSTRAINT|INDEX)/i)) {
        dangerousStatements.push(statement);
        warningType = 'danger';
        warningTitle = 'ALTER Statement Detected';
        warningMessage = userRole && !isSuperRole(userRole)
          ? '⛔ ALTER operations can modify table structure!'
          : 'This will modify the table structure. Proceed with caution!';
        if (isAlterDrop) requiresPassword = isSuper;
      }
    }

    // DELETE — only DELETE without WHERE needs a password on the backend;
    // DELETE with WHERE still gets a confirmation dialog.
    if (upperStatement.match(/^\s*DELETE\s+FROM\s+/i)) {
      dangerousStatements.push(statement);
      warningType = 'danger';
      warningTitle = 'DELETE Statement Detected';
      const hasWhere = /\s+WHERE\s+/i.test(upperStatement);

      if (userRole && !isSuperRole(userRole)) {
        warningMessage = '⛔ DELETE operations require MASTER/ADMIN role. You will not be able to execute this query.';
      } else if (!hasWhere) {
        warningMessage = 'DELETE without WHERE clause will delete ALL rows from the table! Did you forget the WHERE clause?';
      } else {
        warningMessage = 'This will permanently delete data from the table. Proceed with caution.';
      }
      if (!hasWhere) requiresPassword = isSuper;
    }

    // UPDATE without WHERE — confirmation only; the backend does not require a
    // password for this (it would reject the password check as unnecessary).
    if (upperStatement.match(/^\s*UPDATE\s+/i)) {
      if (!upperStatement.match(/\s+WHERE\s+/i)) {
        dangerousStatements.push(statement);
        warningType = 'danger';
        warningTitle = 'UPDATE Without WHERE Clause';
        warningMessage = 'This will update ALL rows in the table! Did you forget the WHERE clause?';
      }
    }

    // GRANT / REVOKE — permission changes, password required (MASTER).
    if (upperStatement.match(/^\s*GRANT\s+/i)) {
      dangerousStatements.push(statement);
      warningType = 'danger';
      warningTitle = 'GRANT Statement Detected';
      warningMessage = userRole && !isSuperRole(userRole)
        ? '⛔ GRANT operations require MASTER role.'
        : 'This will grant permissions on database objects. MASTER/ADMIN password required.';
      requiresPassword = isSuper;
    }
    if (upperStatement.match(/^\s*REVOKE\s+/i)) {
      dangerousStatements.push(statement);
      warningType = 'danger';
      warningTitle = 'REVOKE Statement Detected';
      warningMessage = userRole && !isSuperRole(userRole)
        ? '⛔ REVOKE operations require MASTER role.'
        : 'This will revoke permissions on database objects. MASTER/ADMIN password required.';
      requiresPassword = isSuper;
    }
  }

  if (dangerousStatements.length > 0) {
    return {
      type: warningType,
      title: warningTitle,
      message: warningMessage,
      affectedStatements: dangerousStatements,
      requiresPassword,
    };
  }

  return null;
};
