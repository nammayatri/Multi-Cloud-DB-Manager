import { useEffect, useState } from 'react';
import {
  Box,
  IconButton,
  MenuItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Select,
  FormControl,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { authAPI, toastNonApiError } from '../../services/api';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { Role, ALL_ROLES } from '../../constants/roles';

interface UserData {
  id: number;
  username: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
}

/**
 * User access management (Admin → Users). ADMIN-only: ConsolePage gates the
 * page on role, and every endpoint here is `requireAdmin` server-side.
 */
const UsersPanel = () => {
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await authAPI.listUsers();
      setUsers(response.users);
    } catch (error) {
      toastNonApiError(error, 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleActivate = async (username: string) => {
    try {
      await authAPI.activateUser(username);
      toast.success(`User ${username} activated`);
      await fetchUsers();
    } catch (error) {
      toastNonApiError(error, 'Failed to activate user');
    }
  };

  const handleDeactivate = async (username: string) => {
    if (username === 'master') {
      toast.error('Cannot deactivate master user');
      return;
    }
    try {
      await authAPI.deactivateUser(username);
      toast.success(`User ${username} deactivated`);
      await fetchUsers();
    } catch (error) {
      toastNonApiError(error, 'Failed to deactivate user');
    }
  };

  const handleRoleChange = async (username: string, newRole: string) => {
    if (username === 'master') {
      toast.error('Cannot change master user role');
      return;
    }
    try {
      await authAPI.changeRole(username, newRole as Role);
      toast.success(`User ${username} role changed to ${newRole}`);
      await fetchUsers();
    } catch (error) {
      toastNonApiError(error, 'Failed to change user role');
    }
  };

  const handleDelete = async (username: string) => {
    if (!confirm(`Are you sure you want to delete user "${username}"? This cannot be undone.`)) {
      return;
    }
    try {
      await authAPI.deleteUser(username);
      toast.success(`User ${username} deleted`);
      await fetchUsers();
    } catch (error) {
      toastNonApiError(error, 'Failed to delete user');
    }
  };

  return (
    <Box sx={{ p: 1, flex: 1, overflow: 'auto' }}>
      <TableContainer component={Paper} elevation={3}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Username</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Created At</TableCell>
              <TableCell align="center">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  No users found
                </TableCell>
              </TableRow>
            ) : (
              users.map((userData) => (
                <TableRow key={userData.id}>
                  <TableCell>{userData.id}</TableCell>
                  <TableCell>{userData.username}</TableCell>
                  <TableCell>{userData.name}</TableCell>
                  <TableCell>{userData.email}</TableCell>
                  <TableCell>
                    {userData.username === 'master' ? (
                      <Chip label={userData.role} color="error" size="small" />
                    ) : (
                      <FormControl size="small" sx={{ minWidth: 140 }}>
                        <Select
                          value={userData.role}
                          onChange={(e) => handleRoleChange(userData.username, e.target.value)}
                        >
                          {ALL_ROLES.map((r) => (
                            <MenuItem key={r} value={r}>{r}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    )}
                  </TableCell>
                  <TableCell>
                    {userData.is_active ? (
                      <Chip label="Active" color="success" size="small" />
                    ) : (
                      <Chip label="Inactive" color="default" size="small" />
                    )}
                  </TableCell>
                  <TableCell>
                    {format(new Date(userData.created_at), 'MMM dd, yyyy HH:mm')}
                  </TableCell>
                  <TableCell align="center">
                    {userData.username === 'master' ? (
                      <Typography variant="caption" color="text.secondary">
                        Protected
                      </Typography>
                    ) : (
                      <Stack direction="row" spacing={1} justifyContent="center">
                        <Button
                          variant="outlined"
                          size="small"
                          color={userData.is_active ? 'error' : 'success'}
                          onClick={() =>
                            userData.is_active
                              ? handleDeactivate(userData.username)
                              : handleActivate(userData.username)
                          }
                        >
                          {userData.is_active ? 'Deactivate' : 'Activate'}
                        </Button>
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => handleDelete(userData.username)}
                          title="Delete user"
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};

export default UsersPanel;
