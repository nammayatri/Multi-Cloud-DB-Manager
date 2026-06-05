import { Router } from 'express';
import {
  getCurrentUser,
  register,
  login,
  logout,
  activateUsers,
  deactivateUsers,
  changeUserRole,
  deleteUser,
  listUsers,
  searchUsers
} from '../controllers/auth.controller';
import { isAuthenticated, requireAdmin } from '../middleware/auth.middleware';

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

// User-administration routes — exclusively ADMIN. ADMIN has everything MASTER
// does plus user-access management; MASTER no longer manages users.
console.log('[AUTH ROUTES] Registering POST /activate route (ADMIN only)');
router.post('/activate', isAuthenticated, requireAdmin, activateUsers);

console.log('[AUTH ROUTES] Registering POST /deactivate route (ADMIN only)');
router.post('/deactivate', isAuthenticated, requireAdmin, deactivateUsers);

console.log('[AUTH ROUTES] Registering POST /change-role route (ADMIN only)');
router.post('/change-role', isAuthenticated, requireAdmin, changeUserRole);

console.log('[AUTH ROUTES] Registering POST /delete route (ADMIN only)');
router.post('/delete', isAuthenticated, requireAdmin, deleteUser);

console.log('[AUTH ROUTES] Registering GET /users/search route (ADMIN only)');
router.get('/users/search', isAuthenticated, requireAdmin, searchUsers);

console.log('[AUTH ROUTES] Registering GET /users route (ADMIN only)');
router.get('/users', isAuthenticated, requireAdmin, listUsers);

console.log('[AUTH ROUTES] Auth routes configured');
export default router;
