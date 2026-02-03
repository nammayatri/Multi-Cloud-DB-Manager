import { useEffect, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Chip,
  IconButton,
  Stack,
  TextField,
  MenuItem,
  Divider,
  Alert,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { format } from 'date-fns';
import { historyAPI } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import toast from 'react-hot-toast';
import type { QueryExecution } from '../../types';

const QueryHistory = () => {
  const { queryHistory, setQueryHistory, setCurrentQuery } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'primary' | 'secondary'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all');

  const loadHistory = async () => {
    setLoading(true);
    try {
      const history = await historyAPI.getHistory({
        database: filter === 'all' ? undefined : filter,
        success:
          statusFilter === 'all'
            ? undefined
            : statusFilter === 'success'
            ? true
            : false,
        limit: 50,
      });
      setQueryHistory(history);
    } catch (error) {
      toast.error('Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, [filter, statusFilter]);

  const handleCopyQuery = async (query: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering the list item click
    try {
      await navigator.clipboard.writeText(query);
      toast.success('Query copied to clipboard');
    } catch (error) {
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleLoadQuery = (query: string) => {
    setCurrentQuery(query);
    toast.success('Query loaded into editor');
  };

  const getSuccessStatus = (execution: QueryExecution) => {
    if (execution.execution_mode === 'both') {
      return execution.gcp_success && execution.aws_success;
    } else if (execution.execution_mode === 'gcp') {
      return execution.gcp_success;
    } else {
      return execution.aws_success;
    }
  };

  return (
    <Paper elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Typography variant="h6">Query History</Typography>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton onClick={loadHistory} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Stack>

        {/* Filters */}
        <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
          <TextField
            select
            size="small"
            label="Schema"
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
            sx={{ minWidth: 120 }}
          >
            <MenuItem value="all">All Schemas</MenuItem>
            <MenuItem value="primary">schema_name_1</MenuItem>
            <MenuItem value="secondary">schema_name_2</MenuItem>
          </TextField>

          <TextField
            select
            size="small"
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            sx={{ minWidth: 120 }}
          >
            <MenuItem value="all">All Status</MenuItem>
            <MenuItem value="success">Success</MenuItem>
            <MenuItem value="failed">Failed</MenuItem>
          </TextField>
        </Stack>
      </Box>

      {/* List */}
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {loading ? (
          <Box sx={{ p: 2, textAlign: 'center' }}>
            <Typography color="text.secondary">Loading...</Typography>
          </Box>
        ) : queryHistory.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="info">No query history found</Alert>
          </Box>
        ) : (
          <List>
            {queryHistory.map((execution, index) => (
              <Box key={execution.id}>
                {index > 0 && <Divider />}
                <ListItem
                  disablePadding
                  secondaryAction={
                    <IconButton
                      edge="end"
                      onClick={(e) => handleCopyQuery(execution.query, e)}
                      title="Copy to clipboard"
                    >
                      <ContentCopyIcon />
                    </IconButton>
                  }
                >
                  <ListItemButton onClick={() => handleLoadQuery(execution.query)}>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center">
                          {getSuccessStatus(execution) ? (
                            <CheckCircleIcon fontSize="small" color="success" />
                          ) : (
                            <ErrorIcon fontSize="small" color="error" />
                          )}
                          <Typography
                            variant="body2"
                            sx={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 300,
                            }}
                          >
                            {execution.query}
                          </Typography>
                        </Stack>
                      }
                      secondary={
                        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                          <Chip
                            label={execution.database_schema.toUpperCase()}
                            size="small"
                            variant="outlined"
                          />
                          <Chip
                            label={execution.execution_mode.toUpperCase()}
                            size="small"
                            variant="outlined"
                          />
                          <Typography variant="caption" color="text.secondary">
                            {format(new Date(execution.created_at), 'MMM d, HH:mm')}
                          </Typography>
                          {execution.gcp_duration_ms && (
                            <Typography variant="caption" color="text.secondary">
                              CLOUD2: {execution.gcp_duration_ms}ms
                            </Typography>
                          )}
                          {execution.aws_duration_ms && (
                            <Typography variant="caption" color="text.secondary">
                              CLOUD1: {execution.aws_duration_ms}ms
                            </Typography>
                          )}
                        </Stack>
                      }
                    />
                  </ListItemButton>
                </ListItem>
              </Box>
            ))}
          </List>
        )}
      </Box>
    </Paper>
  );
};

export default QueryHistory;
