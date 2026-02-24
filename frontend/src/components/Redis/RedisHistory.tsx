import { useEffect, useState, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  List,
  ListItem,
  ListItemText,
  Chip,
  IconButton,
  Stack,
  Divider,
  Alert,
  Button,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import PersonIcon from '@mui/icons-material/Person';
import { format } from 'date-fns';
import { redisAPI } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import toast from 'react-hot-toast';

const ITEMS_PER_PAGE = 20;

interface RedisHistoryEntry {
  id: string;
  user_id: string;
  operation: string;
  cloud: string;
  details: Record<string, any>;
  cloud_results: Record<string, any>;
  created_at: string;
  username?: string;
  email?: string;
  name?: string;
}

const RedisHistory = () => {
  const { user } = useAppStore();
  const [history, setHistory] = useState<RedisHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const isMaster = user?.role === 'MASTER';

  const loadHistory = async () => {
    setLoading(true);
    try {
      const offset = (currentPage - 1) * ITEMS_PER_PAGE;
      const data = await redisAPI.getHistory({
        limit: ITEMS_PER_PAGE,
        offset,
      });
      setHistory(data);
    } catch (error) {
      toast.error('Failed to load Redis history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, [currentPage]);

  const handleCopyDetails = async (entry: RedisHistoryEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const text = entry.operation === 'SCAN_DELETE'
        ? `SCAN_DELETE pattern="${entry.details.pattern}" cloud=${entry.cloud}`
        : `${entry.details.command} ${JSON.stringify(entry.details.args)}`;
      await navigator.clipboard.writeText(text);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const getOperationLabel = (entry: RedisHistoryEntry): string => {
    if (entry.operation === 'SCAN_DELETE') {
      return `SCAN_DELETE "${entry.details.pattern}"`;
    }
    if (entry.operation === 'RAW') {
      return `RAW: ${String(entry.details.args?.rawCommand || '').substring(0, 60)}`;
    }
    const args = entry.details.args || {};
    const key = args.key ? ` ${args.key}` : '';
    return `${entry.operation}${key}`;
  };

  const getSuccessStatus = (entry: RedisHistoryEntry): boolean => {
    const results = entry.cloud_results || {};
    const keys = Object.keys(results);
    if (keys.length === 0) return true;
    // For SCAN_DELETE, just check if it started
    if (entry.operation === 'SCAN_DELETE') return true;
    return keys.every((k) => results[k]?.success !== false);
  };

  return (
    <Paper elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Typography variant="h6">Redis History</Typography>
          <Typography variant="caption" color="text.secondary">
            (Write ops only)
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton onClick={loadHistory} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Stack>
      </Box>

      {/* List */}
      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {loading ? (
          <Box sx={{ p: 2, textAlign: 'center' }}>
            <Typography color="text.secondary">Loading...</Typography>
          </Box>
        ) : history.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="info">No Redis write operations recorded yet</Alert>
          </Box>
        ) : (
          <List>
            {history.map((entry, index) => (
              <Box key={entry.id}>
                {index > 0 && <Divider />}
                <ListItem
                  disablePadding
                  secondaryAction={
                    <IconButton
                      edge="end"
                      onClick={(e) => handleCopyDetails(entry, e)}
                      title="Copy to clipboard"
                    >
                      <ContentCopyIcon />
                    </IconButton>
                  }
                >
                  <ListItemText
                    sx={{ px: 2, py: 1 }}
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center">
                        {getSuccessStatus(entry) ? (
                          <CheckCircleIcon fontSize="small" color="success" />
                        ) : (
                          <ErrorIcon fontSize="small" color="error" />
                        )}
                        <Typography
                          variant="body2"
                          sx={{
                            fontFamily: 'monospace',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: 300,
                          }}
                        >
                          {getOperationLabel(entry)}
                        </Typography>
                      </Stack>
                    }
                    secondary={
                      <Stack direction="column" spacing={0.5} sx={{ mt: 0.5 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Chip
                            label={entry.operation}
                            size="small"
                            variant="outlined"
                            color={entry.operation === 'SCAN_DELETE' ? 'error' : 'default'}
                          />
                          <Chip
                            label={entry.cloud.toUpperCase()}
                            size="small"
                            variant="outlined"
                          />
                          <Typography variant="caption" color="text.secondary">
                            {format(new Date(entry.created_at), 'MMM d, HH:mm')}
                          </Typography>
                          {/* Show duration from cloud results */}
                          {Object.entries(entry.cloud_results).map(([cloud, result]: [string, any]) => (
                            result?.duration_ms != null && (
                              <Typography key={cloud} variant="caption" color="text.secondary">
                                {cloud.toUpperCase()}: {result.duration_ms}ms
                              </Typography>
                            )
                          ))}
                        </Stack>
                        {isMaster && (
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <PersonIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                            <Typography variant="caption" color="primary.light" sx={{ fontWeight: 500 }}>
                              {entry.username || entry.name || entry.email}
                            </Typography>
                          </Stack>
                        )}
                        {!isMaster && entry.name && (
                          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                            Run by: {entry.name || entry.email}
                          </Typography>
                        )}
                      </Stack>
                    }
                  />
                </ListItem>
              </Box>
            ))}
          </List>
        )}
      </Box>

      {/* Pagination */}
      {!loading && history.length > 0 && (
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary">
            Page {currentPage}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<ChevronLeftIcon />}
              disabled={currentPage === 1}
              onClick={() => setCurrentPage(currentPage - 1)}
            >
              Prev
            </Button>
            <Button
              size="small"
              variant="outlined"
              endIcon={<ChevronRightIcon />}
              disabled={history.length < ITEMS_PER_PAGE}
              onClick={() => setCurrentPage(currentPage + 1)}
            >
              Next
            </Button>
          </Stack>
        </Box>
      )}
    </Paper>
  );
};

export default RedisHistory;
