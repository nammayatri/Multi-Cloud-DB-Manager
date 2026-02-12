import { useEffect, useState, useRef } from 'react';
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
  Button,
  Pagination,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { format } from 'date-fns';
import { historyAPI, schemaAPI } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import toast from 'react-hot-toast';
import type { QueryExecution, DatabaseInfo } from '../../types';

const ITEMS_PER_PAGE = 20;

const QueryHistory = () => {
  const { queryHistory, setQueryHistory, setCurrentQuery } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const offset = (currentPage - 1) * ITEMS_PER_PAGE;
      const history = await historyAPI.getHistory({
        database: filter === 'all' ? undefined : filter,
        success:
          statusFilter === 'all'
            ? undefined
            : statusFilter === 'success'
            ? true
            : false,
        limit: ITEMS_PER_PAGE,
        offset,
      });
      setQueryHistory(history);

      // If we got exactly ITEMS_PER_PAGE items, there might be more
      // This is a simple estimation - ideally backend should return total count
      if (history.length === ITEMS_PER_PAGE) {
        setTotalCount(currentPage * ITEMS_PER_PAGE + 1); // At least one more page
      } else {
        setTotalCount((currentPage - 1) * ITEMS_PER_PAGE + history.length);
      }
    } catch (error) {
      toast.error('Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  // Fetch database configuration on mount
  useEffect(() => {
    const fetchDatabases = async () => {
      try {
        const config = await schemaAPI.getConfiguration();
        setDatabases(config.primary.databases);
      } catch (error) {
        console.error('Failed to fetch database configuration:', error);
      }
    };
    fetchDatabases();
  }, []);

  // Single effect - load history when any dependency changes
  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, filter, statusFilter]);

  // Separate effect - reset to page 1 when filters change
  const prevFilter = useRef(filter);
  const prevStatusFilter = useRef(statusFilter);

  useEffect(() => {
    const filterChanged = prevFilter.current !== filter;
    const statusFilterChanged = prevStatusFilter.current !== statusFilter;

    if ((filterChanged || statusFilterChanged) && currentPage !== 1) {
      setCurrentPage(1);
    }

    prevFilter.current = filter;
    prevStatusFilter.current = statusFilter;
  }, [filter, statusFilter, currentPage]);

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
    const results = execution.cloud_results || {};
    const cloudKeys = Object.keys(results);
    if (cloudKeys.length === 0) return false;
    return cloudKeys.every((key) => results[key]?.success === true);
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
            label="Database"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="all">All Databases</MenuItem>
            {databases.map((db) => (
              <MenuItem key={db.name} value={db.name}>
                {db.label}
              </MenuItem>
            ))}
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
                        <Stack direction="column" spacing={0.5} sx={{ mt: 0.5 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Chip
                              label={(execution.database_name || '').toUpperCase()}
                              size="small"
                              variant="outlined"
                            />
                            <Chip
                              label={(execution.execution_mode || '').toUpperCase()}
                              size="small"
                              variant="outlined"
                            />
                            <Typography variant="caption" color="text.secondary">
                              {format(new Date(execution.created_at), 'MMM d, HH:mm')}
                            </Typography>
                            {execution.cloud_results && Object.entries(execution.cloud_results).map(([cloud, result]: [string, any]) => (
                              result?.duration_ms != null && (
                                <Typography key={cloud} variant="caption" color="text.secondary">
                                  {cloud.toUpperCase()}: {result.duration_ms}ms
                                </Typography>
                              )
                            ))}
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                            Run by: {execution.name || execution.email}
                          </Typography>
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

      {/* Pagination */}
      {!loading && queryHistory.length > 0 && (
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary">
            Page {currentPage} • Showing {queryHistory.length} queries
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
              disabled={queryHistory.length < ITEMS_PER_PAGE}
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

export default QueryHistory;
