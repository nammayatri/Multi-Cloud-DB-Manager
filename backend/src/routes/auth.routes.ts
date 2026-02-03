import { Router } from 'express';
import {
  getCurrentUser,
  register,
  login,
  logout,
  activateUsers,
  deactivateUsers,
  changeUserRole,
  listUsers
} from '../controllers/auth.controller';
import { isAuthenticated, requireMaster } from '../middleware/auth.middleware';

console.log('[AUTH ROUTES] Loading auth routes...');
const router = Router();

// Public routes (no authentication required)
console.log('[AUTH ROUTES] Registering POST /register route');
router.post('/register', register);

console.log('[AUTH ROUTES] Registering POST /login route');
router.post('/login', login);

// Authenticated routes
console.log('[AUTH ROUTES] Registering GET /me route');
router.get('/me', isAuthenticated, getCurrentUser);

console.log('[AUTH ROUTES] Registering POST /logout route');
router.post('/logout', isAuthenticated, logout);

// MASTER-only routes
console.log('[AUTH ROUTES] Registering POST /activate route (MASTER only)');
router.post('/activate', isAuthenticated, requireMaster, activateUsers);

console.log('[AUTH ROUTES] Registering POST /deactivate route (MASTER only)');
router.post('/deactivate', isAuthenticated, requireMaster, deactivateUsers);

console.log('[AUTH ROUTES] Registering POST /change-role route (MASTER only)');
router.post('/change-role', isAuthenticated, requireMaster, changeUserRole);

console.log('[AUTH ROUTES] Registering GET /users route (MASTER only)');
router.get('/users', isAuthenticated, requireMaster, listUsers);

console.log('[AUTH ROUTES] Auth routes configured');
export default router;
