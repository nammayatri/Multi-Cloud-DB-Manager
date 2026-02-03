import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Avatar,
  Menu,
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
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { authAPI } from '../services/api';
import { useAppStore } from '../store/appStore';
import toast from 'react-hot-toast';
import { format } from 'date-fns';

interface UserData {
  id: number;
  username: string;
  email: string;
  name: string;
  role: 'MASTER' | 'USER' | 'READER';
  is_active: boolean;
  created_at: string;
}

const UsersPage = () => {
  const navigate = useNavigate();
  const { user, setUser } = useAppStore();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check authentication and authorization
    const checkAuth = async () => {
      try {
        const currentUser = await authAPI.getCurrentUser();
        setUser(currentUser);

        // Only MASTER can access this page
        if (currentUser.role !== 'MASTER') {
          toast.error('Access denied. MASTER role required.');
          navigate('/');
          return;
        }

        // Fetch users
        await fetchUsers();
      } catch (error) {
        navigate('/login');
      }
    };

    checkAuth();
  }, []);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await authAPI.listUsers();
      setUsers(response.users);
    } catch (error) {
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await authAPI.logout();
      setUser(null);
      navigate('/login');
      toast.success('Logged out successfully');
    } catch (error) {
      toast.error('Logout failed');
    }
  };

  const handleActivate = async (username: string) => {
    try {
      await authAPI.activateUser(username);
      toast.success(`User ${username} activated`);
      await fetchUsers();
    } catch (error) {
      toast.error('Failed to activate user');
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
      toast.error('Failed to deactivate user');
    }
  };

  const handleRoleChange = async (username: string, newRole: string) => {
    if (username === 'master') {
      toast.error('Cannot change master user role');
      return;
    }
    try {
      await authAPI.changeRole(username, newRole as 'MASTER' | 'USER' | 'READER');
      toast.success(`User ${username} role changed to ${newRole}`);
      await fetchUsers();
    } catch (error) {
      toast.error('Failed to change user role');
    }
  };

  if (!user || user.role !== 'MASTER') {
    return <Box>Loading...</Box>;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top Bar */}
      <AppBar position="static" elevation={2}>
        <Toolbar>
          <IconButton
            color="inherit"
            onClick={() => navigate('/')}
            sx={{ mr: 2 }}
          >
            <ArrowBackIcon />
          </IconButton>

          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            User Management
          </Typography>

          <Stack direction="row" spacing={2} alignItems="center">
            <IconButton
              onClick={(e) => setAnchorEl(e.currentTarget)}
              sx={{ p: 0 }}
            >
              <Avatar
                alt={user.name}
                src={user.picture}
                sx={{ width: 32, height: 32 }}
              />
            </IconButton>

            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={() => setAnchorEl(null)}
            >
              <MenuItem disabled>
                <Box>
                  <Typography variant="subtitle2">{user.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {user.email}
                  </Typography>
                </Box>
              </MenuItem>
              <MenuItem onClick={handleLogout}>
                <LogoutIcon fontSize="small" sx={{ mr: 1 }} />
                Logout
              </MenuItem>
            </Menu>
          </Stack>
        </Toolbar>
      </AppBar>

      {/* Main Content */}
      <Box sx={{ p: 3, flexGrow: 1, overflow: 'auto' }}>
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
                        <FormControl size="small" sx={{ minWidth: 100 }}>
                          <Select
                            value={userData.role}
                            onChange={(e) => handleRoleChange(userData.username, e.target.value)}
                          >
                            <MenuItem value="MASTER">MASTER</MenuItem>
                            <MenuItem value="USER">USER</MenuItem>
                            <MenuItem value="READER">READER</MenuItem>
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
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </Box>
  );
};

export default UsersPage;
