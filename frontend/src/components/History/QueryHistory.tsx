import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
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
  Autocomplete,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import PersonIcon from '@mui/icons-material/Person';
import { format } from 'date-fns';
import { historyAPI, authAPI, schemaAPI } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import toast from 'react-hot-toast';
import type { QueryExecution, DatabaseInfo } from '../../types';

const ITEMS_PER_PAGE = 20;

interface UserOption {
  id: string;
  username: string;
  name: string;
}

const QueryHistory = () => {
  const user = useAppStore(s => s.user);
  const queryHistory = useAppStore(s => s.queryHistory);
  const setQueryHistory = useAppStore(s => s.setQueryHistory);
  const setCurrentQuery = useAppStore(s => s.setCurrentQuery);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all');
  const [userFilter, setUserFilter] = useState<string>('all');
  const [selectedUser, setSelectedUser] = useState<UserOption | null>(null);
  const [searchResults, setSearchResults] = useState<UserOption[]>([]);
  const [userSearchInput, setUserSearchInput] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const isMaster = user?.role === 'MASTER';
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Derive unique users from current history page
  const historyUsers = useMemo(() => {
    const seen = new Map<string, UserOption>();
    for (const exec of queryHistory) {
      if (exec.user_id && !seen.has(exec.user_id)) {
        seen.set(exec.user_id, {
          id: exec.user_id,
          username: exec.username || '',
          name: exec.name || exec.username || '',
        });
      }
    }
    return Array.from(seen.values());
  }, [queryHistory]);

  // Merge history users + search results, deduplicated
  const userOptions = useMemo(() => {
    const map = new Map<string, UserOption>();
    for (const u of historyUsers) map.set(u.id, u);
    for (const u of searchResults) map.set(u.id, u);
    return Array.from(map.values()).sort((a, b) =>
      (a.name || a.username).localeCompare(b.name || b.username)
    );
  }, [historyUsers, searchResults]);

  // Debounced search
  const handleSearchInput = useCallback((input: string) => {
    setUserSearchInput(input);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!input.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const response = await authAPI.searchUsers(input.trim());
        setSearchResults(
          response.users.map((u) => ({ id: u.id, username: u.username, name: u.name || u.username }))
        );
      } catch {
        // Silently fail search
      }
    }, 300);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const offset = (currentPage - 1) * ITEMS_PER_PAGE;
      const history = await historyAPI.getHistory({
        database: filter === 'all' ? undefined : filter,
        user_id: isMaster && userFilter !== 'all' ? userFilter : undefined,
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

      if (history.length === ITEMS_PER_PAGE) {
        setTotalCount(currentPage * ITEMS_PER_PAGE + 1);
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
  }, [currentPage, filter, statusFilter, userFilter]);

  // Separate effect - reset to page 1 when filters change
  const prevFilter = useRef(filter);
  const prevStatusFilter = useRef(statusFilter);
  const prevUserFilter = useRef(userFilter);

  useEffect(() => {
    const filterChanged = prevFilter.current !== filter;
    const statusFilterChanged = prevStatusFilter.current !== statusFilter;
    const userFilterChanged = prevUserFilter.current !== userFilter;

    if ((filterChanged || statusFilterChanged || userFilterChanged) && currentPage !== 1) {
      setCurrentPage(1);
    }

    prevFilter.current = filter;
    prevStatusFilter.current = statusFilter;
    prevUserFilter.current = userFilter;
  }, [filter, statusFilter, userFilter, currentPage]);

  const handleCopyQuery = async (query: string, e: React.MouseEvent) => {
    e.stopPropagation();
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

          {isMaster && (
            <Autocomplete
              size="small"
              sx={{ minWidth: 200 }}
              options={userOptions}
              getOptionLabel={(option) => option.name || option.username}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              value={selectedUser}
              inputValue={userSearchInput}
              onInputChange={(_e, value, reason) => {
                if (reason === 'input') handleSearchInput(value);
                else setUserSearchInput(value);
              }}
              onChange={(_e, value) => {
                setSelectedUser(value);
                setUserFilter(value ? value.id : 'all');
                setSearchResults([]);
              }}
              renderInput={(params) => <TextField {...params} label="User" placeholder="Search users..." />}
              renderOption={(props, option) => (
                <li {...props} key={option.id}>
                  <Stack>
                    <Typography variant="body2">{option.name || option.username}</Typography>
                    {option.name && option.username && (
                      <Typography variant="caption" color="text.secondary">
                        @{option.username}
                      </Typography>
                    )}
                  </Stack>
                </li>
              )}
              filterOptions={(x) => x}
              noOptionsText={userSearchInput ? 'No users found' : 'Type to search'}
            />
          )}
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
                          {isMaster && (
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              <PersonIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                              <Typography variant="caption" color="primary.light" sx={{ fontWeight: 500 }}>
                                {execution.username || execution.name || execution.email}
                              </Typography>
                              {execution.name && execution.username && (
                                <Typography variant="caption" color="text.secondary">
                                  ({execution.name})
                                </Typography>
                              )}
                            </Stack>
                          )}
                          {!isMaster && (
                            <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                              Run by: {execution.name || execution.email}
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

export default React.memo(QueryHistory);
