import bcrypt from 'bcryptjs';
import DatabasePools from '../config/database';

/**
 * Re-verify a logged-in user's password.
 *
 * Used by the two places that gate a sensitive operation behind a password
 * challenge: direct execution of an ALTER/DROP query, and approval of a query
 * request containing one.
 *
 * Returns null when the user row is missing (session outlived the account).
 */
export const verifyUserPassword = async (
  username: string,
  password: string
): Promise<boolean | null> => {
  const historyPool = DatabasePools.getInstance().history;

  const userResult = await historyPool.query(
    'SELECT password_hash FROM dual_db_manager.users WHERE username = $1',
    [username]
  );

  if (userResult.rows.length === 0) {
    return null;
  }

  return bcrypt.compare(password, userResult.rows[0].password_hash);
};
