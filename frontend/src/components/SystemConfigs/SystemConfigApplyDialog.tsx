import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import WarningIcon from '@mui/icons-material/Warning';
import type { SystemConfigTargetInfo } from '../../types';

interface SystemConfigApplyDialogProps {
  open: boolean;
  target: SystemConfigTargetInfo | null;
  configId: string;
  oldValue: string | null;
  newValue: string;
  applying: boolean;
  /** Server-side error to show inline (e.g. 'Invalid password'); dialog stays open. */
  errorMessage: string;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}

const ValueBox = ({ label, value }: { label: string; value: string | null }) => (
  <Box sx={{ flex: 1, minWidth: 0 }}>
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
      {label} ({value === null ? 'NULL' : `${value.length} chars`})
    </Typography>
    <Paper
      variant="outlined"
      sx={{ p: 1, maxHeight: 180, overflow: 'auto', bgcolor: 'background.default' }}
    >
      <Box
        component="pre"
        sx={{
          m: 0,
          fontFamily: 'monospace',
          fontSize: '0.75rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {value === null ? 'NULL' : value}
      </Box>
    </Paper>
  </Box>
);

/**
 * Confirm dialog for applying a system config UPDATE. Mirrors the destructive
 * DROP/TRUNCATE password-verification UX (QueryWarningDialog): summary of what
 * runs where, manager-password field, Verify & Apply.
 */
const SystemConfigApplyDialog = ({
  open,
  target,
  configId,
  oldValue,
  newValue,
  applying,
  errorMessage,
  onConfirm,
  onCancel,
}: SystemConfigApplyDialogProps) => {
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');

  // Clear the password whenever the dialog opens OR closes — the cleartext
  // password must never linger in state after the dialog is dismissed. (On a
  // wrong password `open` stays true, so the field keeps its value to correct.)
  useEffect(() => {
    setPassword('');
    setLocalError('');
  }, [open]);

  if (!target) return null;

  const handleConfirm = () => {
    if (!password.trim()) {
      setLocalError('Password is required to apply this update');
      return;
    }
    onConfirm(password);
  };

  const handleCancel = () => {
    if (applying) return;
    setPassword('');
    setLocalError('');
    onCancel();
  };

  const fieldError = localError;

  return (
    <Dialog open={open} onClose={handleCancel} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <WarningIcon color="warning" fontSize="large" />
        Apply config update?
      </DialogTitle>

      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2 }}>
          This will UPDATE <strong>{configId}</strong> in{' '}
          <strong>{target.schema}.system_configs</strong> ({target.label}). The write goes
          through the Namma Yatri ops dashboard (runQuery) and is audited.
        </Alert>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <ValueBox label="Current value" value={oldValue} />
          <ValueBox label="New value" value={newValue} />
        </Stack>

        {errorMessage && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {errorMessage}
          </Alert>
        )}

        <TextField
          fullWidth
          type="password"
          label="Enter your password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setLocalError('');
          }}
          error={!!fieldError}
          helperText={fieldError}
          autoFocus
          disabled={applying}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleConfirm();
            }
          }}
        />
      </DialogContent>

      <DialogActions>
        <Button onClick={handleCancel} color="inherit" disabled={applying}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          color="warning"
          variant="contained"
          disabled={!password.trim() || applying}
          startIcon={applying ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {applying ? 'Applying...' : 'Verify & Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SystemConfigApplyDialog;
