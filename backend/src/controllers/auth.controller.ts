import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import logger from '../utils/logger';
import DatabasePools from '../config/database';

export const getCurrentUser = (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ user: req.user });
};



export const logout = (req: Request, res: Response) => {
  const username = (req.user as any)?.username;
  req.session?.destroy((err) => {
    if (err) {
      logger.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    logger.info('User logged out', { username });
    res.json({ message: 'Logged out successfully' });
  });
};

export const activateUsers = async (req: Request, res: Response) => {
  try {
    const { usernames } = req.body;
    if (!usernames || !Array.isArray(usernames)) {
      return res.status(400).json({ error: 'Invalid input' });
    }
    const dbPools = DatabasePools.getInstance();
    const historyPool = dbPools.history;
    const result = await historyPool.query(
      `UPDATE dual_db_manager.users SET is_active = true WHERE username = ANY($1::text[]) RETURNING username`,
      [usernames]
    );
    logger.info('Users activated', { count: result.rowCount });
    res.json({ message: `Activated ${result.rowCount} users`, users: result.rows });
  } catch (error) {
    logger.error('Activation error:', error);
    res.status(500).json({ error: 'Activation failed' });
  }
};

export const deactivateUsers = async (req: Request, res: Response) => {
  try {
    const { usernames } = req.body;
    if (!usernames || !Array.isArray(usernames) || usernames.includes('master')) {
      return res.status(400).json({ error: 'Invalid input or cannot deactivate master' });
    }
    const dbPools = DatabasePools.getInstance();
    const historyPool = dbPools.history;
    const result = await historyPool.query(
      `UPDATE dual_db_manager.users SET is_active = false WHERE username = ANY($1::text[]) AND username != 'master' RETURNING username`,
      [usernames]
    );
    logger.info('Users deactivated', { count: result.rowCount });
    res.json({ message: `Deactivated ${result.rowCount} users`, users: result.rows });
  } catch (error) {
    logger.error('Deactivation error:', error);
    res.status(500).json({ error: 'Deactivation failed' });
  }
};

export const changeUserRole = async (req: Request, res: Response) => {
  try {
    const { username, role } = req.body;
    if (!username || !role || !['MASTER', 'USER', 'READER'].includes(role) || username === 'master') {
      return res.status(400).json({ error: 'Invalid input or cannot change master role' });
    }
    const dbPools = DatabasePools.getInstance();
    const historyPool = dbPools.history;
    const result = await historyPool.query(
      `UPDATE dual_db_manager.users SET role = $1 WHERE username = $2 RETURNING id, username, role`,
      [role, username]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    logger.info('User role changed', { username, role });
    res.json({ message: 'Role updated', user: result.rows[0] });
  } catch (error) {
    logger.error('Role change error:', error);
    res.status(500).json({ error: 'Role change failed' });
  }
};

export const listUsers = async (req: Request, res: Response) => {
  try {
    const dbPools = DatabasePools.getInstance();
    const historyPool = dbPools.history;
    const result = await historyPool.query(
      `SELECT id, username, email, name, role, is_active, created_at FROM dual_db_manager.users ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (error) {
    logger.error('List users error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
};
export const register = async (req: Request, res: Response) => {
  try {
    const { username, password, email, name } = req.body;
    if (!username || !password || !email || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password too short' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const dbPools = DatabasePools.getInstance();
    const historyPool = dbPools.history;
    const result = await historyPool.query(
      `INSERT INTO dual_db_manager.users (username, password_hash, email, name, role, is_active)
       VALUES ($1, $2, $3, $4, 'USER', false) RETURNING id, username, email, name, role, is_active`,
      [username, passwordHash, email, name]
    );
    logger.info('User registered', { username });
    res.status(201).json({
      message: 'Account created. Wait for MASTER activation.',
      user: result.rows[0]
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    logger.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed', message: error.message });
  }
};
export const login = async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    const dbPools = DatabasePools.getInstance();
    const historyPool = dbPools.history;
    const result = await historyPool.query(
      'SELECT id, username, password_hash, email, name, role, is_active, picture FROM dual_db_manager.users WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account not activated' });
    }
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    (req.session as any).passport = { user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role, picture: user.picture || '' } };
    logger.info('User logged in', { username });
    res.json({ message: 'Login successful', user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role, picture: user.picture || '' } });
  } catch (error: any) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed', message: error.message });
  }
};
