import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Alert,
  Paper,
  TextField,
} from '@mui/material';
import WarningIcon from '@mui/icons-material/Warning';
import ErrorIcon from '@mui/icons-material/Error';
import type { ValidationWarning } from '../../services/queryValidation.service';
import { useState } from 'react';

interface QueryWarningDialogProps {
  open: boolean;
  warning: ValidationWarning | null;
  onConfirm: (password?: string) => void;
  onCancel: () => void;
  requiresPassword?: boolean;
  selectedMode?: string;
  cloudNames?: { primary: string; secondary: string[] };
}

const QueryWarningDialog = ({
  open,
  warning,
  onConfirm,
  onCancel,
  requiresPassword = false,
  selectedMode = 'both',
  cloudNames = { primary: '', secondary: [] }
}: QueryWarningDialogProps) => {
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  if (!warning) return null;

  const isDanger = warning.type === 'danger';

  // Build cloud names message
  const getCloudNamesMessage = () => {
    if (selectedMode === 'both') {
      const allClouds = [cloudNames.primary, ...cloudNames.secondary]
        .filter(Boolean)
        .map(c => c.toUpperCase())
        .join(' and ');
      return `This query will be executed on both ${allClouds} databases. Make sure you understand the implications.`;
    } else {
      return `This query will be executed on ${selectedMode.toUpperCase()} database. Make sure you understand the implications.`;
    }
  };

  const handleConfirm = () => {
    if (requiresPassword && !password.trim()) {
      setPasswordError('Password is required to execute this query');
      return;
    }
    const pwd = password;
    setPassword('');
    setPasswordError('');
    onConfirm(requiresPassword ? pwd : undefined);
  };

  const handleCancel = () => {
    setPassword('');
    setPasswordError('');
    onCancel();
  };

  return (
    <Dialog
      open={open}
      onClose={handleCancel}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {isDanger ? (
          <ErrorIcon color="error" fontSize="large" />
        ) : (
          <WarningIcon color="warning" fontSize="large" />
        )}
        {warning.title}
      </DialogTitle>

      <DialogContent>
        <Alert severity={isDanger ? 'error' : 'warning'} sx={{ mb: 2 }}>
          {warning.message}
        </Alert>

        <Typography variant="subtitle2" gutterBottom>
          Affected Statement{warning.affectedStatements.length > 1 ? 's' : ''}:
        </Typography>

        {warning.affectedStatements.map((statement, index) => (
          <Paper
            key={index}
            elevation={0}
            sx={{
              p: 2,
              mb: 1,
              bgcolor: 'background.default',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {statement}
          </Paper>
        ))}

        <Box sx={{ mt: 2, p: 2, bgcolor: 'background.default', borderRadius: 1 }}>
          <Typography variant="body2" color="text.secondary">
            <strong>Note:</strong> {getCloudNamesMessage()}
          </Typography>
        </Box>

        {requiresPassword && (
          <Box sx={{ mt: 3 }}>
            <Alert severity="error" sx={{ mb: 2 }}>
              <strong>MASTER Authentication Required</strong><br />
              This query requires password verification. Only MASTER users can execute ALTER/DROP queries.
            </Alert>
            <TextField
              fullWidth
              type="password"
              label="Enter your password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordError('');
              }}
              error={!!passwordError}
              helperText={passwordError}
              autoFocus
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleConfirm();
                }
              }}
            />
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={handleCancel} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          color={isDanger ? 'error' : 'warning'}
          variant="contained"
          disabled={requiresPassword && !password.trim()}
        >
          {requiresPassword ? 'Verify & Execute' : 'Execute Anyway'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default QueryWarningDialog;
