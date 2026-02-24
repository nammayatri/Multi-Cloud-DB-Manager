import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Alert,
  Chip,
  CircularProgress,
  Stack,
} from '@mui/material';
import StorageIcon from '@mui/icons-material/Storage';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { replicationAPI } from '../../services/api';

interface DetectedTable {
  schema: string;
  table: string;
}

interface ReplicationDialogProps {
  open: boolean;
  tables: DetectedTable[];
  database: string;
  onClose: () => void;
}

interface ReplicationResult {
  publication: { success: boolean; error?: string };
  subscriptions: Array<{ cloud: string; success: boolean; error?: string }>;
}

const ReplicationDialog = ({
  open,
  tables,
  database,
  onClose,
}: ReplicationDialogProps) => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReplicationResult | null>(null);

  const handleAddToReplication = async () => {
    setLoading(true);
    try {
      const response = await replicationAPI.addTables({ tables, database });
      setResult(response.results);
    } catch (err: any) {
      setResult({
        publication: { success: false, error: err.response?.data?.error || err.message },
        subscriptions: [],
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setLoading(false);
    onClose();
  };

  const hasResults = result !== null;

  return (
    <Dialog open={open} onClose={hasResults ? handleClose : undefined} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <StorageIcon color="primary" />
        Add to Logical Replication
      </DialogTitle>

      <DialogContent>
        {!hasResults && (
          <>
            <Alert severity="info" sx={{ mb: 2 }}>
              New tables were created. Would you like to add them to logical replication?
            </Alert>

            <Typography variant="subtitle2" gutterBottom>
              Detected table{tables.length > 1 ? 's' : ''}:
            </Typography>

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
              {tables.map((t, i) => (
                <Chip
                  key={i}
                  label={`${t.schema}.${t.table}`}
                  variant="outlined"
                  color="primary"
                />
              ))}
            </Box>

            <Typography variant="body2" color="text.secondary">
              This will run <code>ALTER PUBLICATION ... ADD TABLE</code> on the primary database
              and <code>ALTER SUBSCRIPTION ... REFRESH PUBLICATION</code> on each secondary cloud.
            </Typography>
          </>
        )}

        {hasResults && (
          <Stack spacing={2}>
            {/* Publication result */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {result.publication.success ? (
                <CheckCircleIcon color="success" />
              ) : (
                <ErrorIcon color="error" />
              )}
              <Typography variant="body1">
                <strong>Publication:</strong>{' '}
                {result.publication.success ? 'Tables added successfully' : 'Failed'}
              </Typography>
            </Box>
            {result.publication.error && (
              <Alert severity="error" sx={{ py: 0 }}>
                {result.publication.error}
              </Alert>
            )}

            {/* Subscription results */}
            {result.subscriptions.map((sub, i) => (
              <Box key={i}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {sub.success ? (
                    <CheckCircleIcon color="success" />
                  ) : (
                    <ErrorIcon color="error" />
                  )}
                  <Typography variant="body1">
                    <strong>Subscription ({sub.cloud}):</strong>{' '}
                    {sub.success ? 'Refreshed successfully' : 'Failed'}
                  </Typography>
                </Box>
                {sub.error && (
                  <Alert severity="error" sx={{ py: 0, mt: 0.5 }}>
                    {sub.error}
                  </Alert>
                )}
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        {!hasResults && (
          <>
            <Button onClick={handleClose} color="inherit" disabled={loading}>
              Skip
            </Button>
            <Button
              onClick={handleAddToReplication}
              variant="contained"
              color="primary"
              disabled={loading}
              startIcon={loading ? <CircularProgress size={18} /> : undefined}
            >
              {loading ? 'Adding...' : 'Add to Replication'}
            </Button>
          </>
        )}
        {hasResults && (
          <Button onClick={handleClose} variant="contained">
            Close
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default ReplicationDialog;
