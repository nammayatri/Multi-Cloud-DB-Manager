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
} from '@mui/material';
import WarningIcon from '@mui/icons-material/Warning';
import ErrorIcon from '@mui/icons-material/Error';
import type { ValidationWarning } from '../../services/queryValidation.service';

interface QueryWarningDialogProps {
  open: boolean;
  warning: ValidationWarning | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const QueryWarningDialog = ({ open, warning, onConfirm, onCancel }: QueryWarningDialogProps) => {
  if (!warning) return null;

  const isDanger = warning.type === 'danger';

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {isDanger ? (
          <ErrorIcon color="error" fontSize="large" />
        ) : (
          <WarningIcon color="warning" fontSize="large" />
        )}
        <Typography variant="h6">{warning.title}</Typography>
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
            <strong>Note:</strong> This query will be executed on both CLOUD2 and CLOUD1 databases
            if "Both" mode is selected. Make sure you understand the implications.
          </Typography>
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onCancel} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          color={isDanger ? 'error' : 'warning'}
          variant="contained"
          autoFocus
        >
          Execute Anyway
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default QueryWarningDialog;
