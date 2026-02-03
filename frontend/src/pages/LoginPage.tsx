import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Container,
  Paper,
  Typography,
  TextField,
  Alert,
  Tabs,
  Tab,
  InputAdornment,
  IconButton,
} from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { authAPI } from '../services/api';
import { useAppStore } from '../store/appStore';
import toast from 'react-hot-toast';

const LoginPage = () => {
  const navigate = useNavigate();
  const { setUser } = useAppStore();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Form fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await authAPI.login(username, password);
      setUser(response.user);
      toast.success('Login successful!');
      navigate('/');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Login failed';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await authAPI.register(username, password, email, name);
      toast.success('Account created! Please wait for MASTER to activate your account.');
      // Switch to login tab
      setTab('login');
      setPassword(''); // Clear password for security
    } catch (error: any) {
      const message = error.response?.data?.message || 'Registration failed';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
      }}
    >
      <Container maxWidth="sm">
        <Paper
          elevation={3}
          sx={{
            p: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          {/* Logo/Title */}
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="h3" component="h1" gutterBottom>
              Dual DB Manager
            </Typography>
            <Typography variant="subtitle1" color="text.secondary">
              Execute queries across AWS and GCP databases
            </Typography>
          </Box>

          {/* Tabs */}
          <Tabs
            value={tab}
            onChange={(_, newValue) => setTab(newValue)}
            centered
          >
            <Tab label="Login" value="login" />
            <Tab label="Register" value="register" />
          </Tabs>

          {/* Login Form */}
          {tab === 'login' && (
            <Box component="form" onSubmit={handleLogin} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                autoComplete="username"
              />
              <TextField
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowPassword(!showPassword)}
                        edge="end"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              <Button
                type="submit"
                variant="contained"
                size="large"
                disabled={loading}
                sx={{ mt: 1 }}
              >
                {loading ? 'Logging in...' : 'Login'}
              </Button>
            </Box>
          )}

          {/* Register Form */}
          {tab === 'register' && (
            <Box component="form" onSubmit={handleRegister} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Alert severity="info">
                New accounts require activation by MASTER before you can login.
              </Alert>
              <TextField
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                helperText="3-30 characters, alphanumeric and underscores only"
                autoComplete="username"
              />
              <TextField
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
              <TextField
                label="Full Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
              <TextField
                label="Password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                helperText="Minimum 6 characters"
                autoComplete="new-password"
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowPassword(!showPassword)}
                        edge="end"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              <Button
                type="submit"
                variant="contained"
                size="large"
                disabled={loading}
                sx={{ mt: 1 }}
              >
                {loading ? 'Creating account...' : 'Register'}
              </Button>
            </Box>
          )}

          {/* Features */}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Features:
            </Typography>
            <Box component="ul" sx={{ pl: 2, mt: 1, mb: 0 }}>
              <Typography component="li" variant="body2" color="text.secondary">
                Role-based access: MASTER, USER, READER
              </Typography>
              <Typography component="li" variant="body2" color="text.secondary">
                Execute queries on AWS and GCP simultaneously
              </Typography>
              <Typography component="li" variant="body2" color="text.secondary">
                Complete query history and audit trail
              </Typography>
            </Box>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
};

export default LoginPage;
