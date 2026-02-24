import { useState, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Alert,
  Chip,
  Stack,
  IconButton,
  Tabs,
  Tab,
  Collapse,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { RedisCommandResponse, RedisCloudResult } from '../../types';

interface RedisResultsPanelProps {
  result: RedisCommandResponse | null;
}

const RedisResultsPanel = ({ result }: RedisResultsPanelProps) => {
  const [expandedClouds, setExpandedClouds] = useState<Record<string, boolean>>({});
  const [cloudTabs, setCloudTabs] = useState<Record<string, 'formatted' | 'json'>>({});

  const cloudResults = useMemo(() => {
    if (!result) return [];
    return Object.entries(result)
      .filter(([key]) => key !== 'id' && key !== 'success' && key !== 'command')
      .map(([cloudName, data]) => ({ cloudName, data: data as RedisCloudResult }));
  }, [result]);

  const isCloudExpanded = (cloudName: string) => expandedClouds[cloudName] !== false;
  const toggleCloud = (cloudName: string) => {
    setExpandedClouds((prev) => ({ ...prev, [cloudName]: !isCloudExpanded(cloudName) }));
  };
  const getTab = (cloudName: string) => cloudTabs[cloudName] || 'formatted';
  const setTab = (cloudName: string, tab: 'formatted' | 'json') => {
    setCloudTabs((prev) => ({ ...prev, [cloudName]: tab }));
  };

  if (!result) {
    return (
      <Paper elevation={2} sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="body1" color="text.secondary">
          Execute a Redis command to see results here
        </Typography>
      </Paper>
    );
  }

  const renderFormattedData = (data: any, command: string) => {
    if (data === null || data === undefined) {
      return <Alert severity="info">Key not found (nil)</Alert>;
    }

    // Scalar values (GET, TTL, TYPE, EXISTS)
    if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
      return (
        <Paper variant="outlined" sx={{ p: 2, bgcolor: '#1e1e1e', color: '#d4d4d4' }}>
          <pre style={{ margin: 0, fontSize: '0.875rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {String(data)}
          </pre>
        </Paper>
      );
    }

    // Array values (MGET, LRANGE, SMEMBERS, ZRANGE, HKEYS)
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return <Alert severity="info">Empty result (no elements)</Alert>;
      }

      // Stream results (XREAD, XREADGROUP) - array of objects
      if (data[0] && typeof data[0] === 'object' && !Array.isArray(data[0])) {
        return (
          <Paper variant="outlined" sx={{ p: 2, bgcolor: '#1e1e1e', color: '#d4d4d4', maxHeight: 400, overflow: 'auto' }}>
            <pre style={{ margin: 0, fontSize: '0.875rem' }}>
              {JSON.stringify(data, null, 2)}
            </pre>
          </Paper>
        );
      }

      // Simple list
      return (
        <TableContainer sx={{ maxHeight: 400 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 'bold', width: 60 }}>#</TableCell>
                <TableCell sx={{ fontWeight: 'bold' }}>Value</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((item, i) => (
                <TableRow key={i} hover>
                  <TableCell>{i}</TableCell>
                  <TableCell>
                    {item === null
                      ? <em style={{ color: 'gray' }}>nil</em>
                      : typeof item === 'object'
                      ? JSON.stringify(item)
                      : String(item)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      );
    }

    // Hash/Object values (HGETALL)
    if (typeof data === 'object') {
      const entries = Object.entries(data);
      if (entries.length === 0) {
        return <Alert severity="info">Empty hash (no fields)</Alert>;
      }

      return (
        <TableContainer sx={{ maxHeight: 400 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 'bold' }}>Field</TableCell>
                <TableCell sx={{ fontWeight: 'bold' }}>Value</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(([field, value]) => (
                <TableRow key={field} hover>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{field}</TableCell>
                  <TableCell>
                    {typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value ?? 'nil')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      );
    }

    return <Alert severity="info">Unexpected result type</Alert>;
  };

  const renderCloudResult = (cloudName: string, data: RedisCloudResult) => {
    if (!data.success) {
      return (
        <Alert severity="error" icon={<ErrorIcon />}>
          <Typography variant="subtitle2">Execution Failed</Typography>
          <Typography variant="body2">{data.error}</Typography>
          <Typography variant="caption">Duration: {data.duration_ms}ms</Typography>
        </Alert>
      );
    }

    const tab = getTab(cloudName);

    return (
      <Box>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <Chip icon={<CheckCircleIcon />} label="Success" color="success" size="medium" />
          <Chip
            label={`${data.duration_ms}ms`}
            color="default"
            variant="outlined"
            size="medium"
            sx={{ fontWeight: 600, fontSize: '0.875rem' }}
          />
        </Stack>

        <Tabs value={tab} onChange={(_, v) => setTab(cloudName, v)} sx={{ mb: 2 }}>
          <Tab label="Formatted" value="formatted" />
          <Tab label="JSON" value="json" />
        </Tabs>

        {tab === 'formatted' && renderFormattedData(data.data, result!.command)}

        {tab === 'json' && (
          <Paper
            variant="outlined"
            sx={{ p: 2, bgcolor: '#1e1e1e', color: '#d4d4d4', maxHeight: 400, overflow: 'auto' }}
          >
            <pre style={{ margin: 0, fontSize: '0.875rem' }}>
              {JSON.stringify(data.data, null, 2)}
            </pre>
          </Paper>
        )}
      </Box>
    );
  };

  return (
    <Paper elevation={2} sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        Redis Results — {result.command}
      </Typography>

      <Stack spacing={3}>
        {cloudResults.map(({ cloudName, data }, index) => {
          const expanded = isCloudExpanded(cloudName);
          const color = index === 0 ? 'primary.main' : index === 1 ? 'secondary.main' : 'info.main';

          return (
            <Box key={cloudName}>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                onClick={() => toggleCloud(cloudName)}
                sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' }, p: 1, borderRadius: 1, mb: 1 }}
              >
                <IconButton size="small" sx={{ p: 0 }}>
                  {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                </IconButton>
                <Typography variant="subtitle1" sx={{ color, fontWeight: 'bold' }}>
                  {cloudName.toUpperCase()} Results
                </Typography>
              </Stack>
              <Collapse in={expanded}>
                {renderCloudResult(cloudName, data)}
              </Collapse>
            </Box>
          );
        })}

        {cloudResults.length === 0 && (
          <Alert severity="info">No results available.</Alert>
        )}
      </Stack>
    </Paper>
  );
};

export default RedisResultsPanel;
