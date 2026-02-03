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
  Button,
  Collapse,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { saveAs } from 'file-saver';
import type { QueryResponse, CloudResult } from '../../types';

interface ResultsPanelProps {
  result: QueryResponse | null;
}

const ResultsPanel = ({ result }: ResultsPanelProps) => {
  const [cloudTabs, setCloudTabs] = useState<Record<string, 'table' | 'json'>>({});
  const [collapsedStatements, setCollapsedStatements] = useState<Set<string>>(new Set());
  const [expandedClouds, setExpandedClouds] = useState<Record<string, boolean>>({});

  // Extract cloud results from QueryResponse (exclude 'id' and 'success' keys)
  const cloudResults = useMemo(() => {
    if (!result) return [];
    return Object.entries(result)
      .filter(([key]) => key !== 'id' && key !== 'success')
      .map(([cloudName, data]) => ({ cloudName, data: data as CloudResult }));
  }, [result]);

  // Get tab for a specific cloud
  const getCloudTab = (cloudName: string) => cloudTabs[cloudName] || 'table';

  // Set tab for a specific cloud
  const setCloudTab = (cloudName: string, tab: 'table' | 'json') => {
    setCloudTabs(prev => ({ ...prev, [cloudName]: tab }));
  };

  // Get expansion state for a cloud
  const isCloudExpanded = (cloudName: string) => {
    return expandedClouds[cloudName] !== undefined ? expandedClouds[cloudName] : true;
  };

  // Toggle expansion for a cloud
  const toggleCloudExpanded = (cloudName: string) => {
    setExpandedClouds(prev => ({ ...prev, [cloudName]: !isCloudExpanded(cloudName) }));
  };

  const toggleStatement = (key: string) => {
    setCollapsedStatements((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  };

  if (!result) {
    return (
      <Paper elevation={2} sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="body1" color="text.secondary">
          Execute a query to see results here
        </Typography>
      </Paper>
    );
  }

  const exportToCSV = (data: any[], filename: string) => {
    if (!data || data.length === 0) return;

    const headers = Object.keys(data[0]);
    const csvContent = [
      headers.join(','),
      ...data.map((row) => headers.map((h) => JSON.stringify(row[h] ?? '')).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, filename);
  };

  const exportToJSON = (data: any[], filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    saveAs(blob, filename);
  };

  const renderResultView = (
    cloudName: string,
    data: CloudResult | undefined,
    tab: 'table' | 'json',
    setTab: (tab: 'table' | 'json') => void
  ) => {
    if (!data) {
      return (
        <Alert severity="info">
          No {cloudName.toUpperCase()} execution (mode was not set to include this cloud)
        </Alert>
      );
    }

    // Check if this is a multi-statement result FIRST (before success check)
    if (data.results && data.results.length > 0) {
      return (
        <Box>
          {/* Multi-statement header */}
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
            <Chip
              icon={<CheckCircleIcon />}
              label="Multi-Statement"
              color="success"
              size="medium"
            />
            <Chip
              label={`${data.statementCount} statement${data.statementCount !== 1 ? 's' : ''}`}
              color="primary"
              variant="outlined"
              size="medium"
              sx={{ fontWeight: 600, fontSize: '0.875rem' }}
            />
            <Chip
              label={`${data.duration_ms}ms total`}
              color="default"
              variant="outlined"
              size="medium"
              sx={{ fontWeight: 600, fontSize: '0.875rem' }}
            />
          </Stack>

          {/* Each statement result */}
          <Stack spacing={2}>
            {data.results.map((stmt, index) => {
              const stmtKey = `${cloudName}-${index}`;
              const isExpanded = !collapsedStatements.has(stmtKey);

              return (
                <Paper key={index} variant="outlined" sx={{ p: 2 }}>
                  <Stack spacing={1}>
                    {/* Statement header */}
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption" sx={{ fontFamily: 'monospace', bgcolor: '#1e1e1e', color: '#d4d4d4', px: 1, py: 0.5, borderRadius: 0.5 }}>
                        Statement {index + 1}
                      </Typography>
                      {stmt.success ? (
                        <Chip label="Success" color="success" size="medium" />
                      ) : (
                        <Chip label="Error" color="error" size="medium" />
                      )}
                      {stmt.rowsAffected !== undefined && (
                        <Chip
                          label={`${stmt.rowsAffected} row${stmt.rowsAffected !== 1 ? 's' : ''}`}
                          color="primary"
                          size="medium"
                          variant="outlined"
                          sx={{ fontWeight: 600 }}
                        />
                      )}
                    </Stack>

                    {/* Statement SQL - Expandable */}
                    <Box>
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        onClick={() => toggleStatement(stmtKey)}
                        sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' }, p: 0.5, borderRadius: 0.5 }}
                      >
                        <IconButton size="small" sx={{ p: 0 }}>
                          {isExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                        </IconButton>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                          {isExpanded ? 'Hide SQL' : 'Show SQL'}
                        </Typography>
                      </Stack>
                      <Collapse in={isExpanded}>
                        <Paper
                          variant="outlined"
                          sx={{
                            p: 1.5,
                            mt: 1,
                            bgcolor: '#1e1e1e',
                            color: '#d4d4d4',
                            maxHeight: 200,
                            overflow: 'auto'
                          }}
                        >
                          <pre style={{ margin: 0, fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {stmt.statement}
                          </pre>
                        </Paper>
                      </Collapse>
                    </Box>

                  {/* Statement error */}
                  {!stmt.success && stmt.error && (
                    <Alert severity="error" sx={{ mt: 1 }}>
                      {stmt.error}
                    </Alert>
                  )}

                  {/* Statement results (if SELECT) */}
                  {stmt.success && stmt.result && stmt.result.rows && stmt.result.rows.length > 0 && (
                    <TableContainer sx={{ maxHeight: 300, mt: 1 }}>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            {Object.keys(stmt.result.rows[0]).map((column) => (
                              <TableCell key={column} sx={{ fontWeight: 'bold' }}>
                                {column}
                              </TableCell>
                            ))}
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {stmt.result.rows.map((row, rowIndex) => (
                            <TableRow key={rowIndex} hover>
                              {Object.values(row).map((value: any, cellIndex) => (
                                <TableCell key={cellIndex}>
                                  {value === null
                                    ? <em style={{ color: 'gray' }}>NULL</em>
                                    : typeof value === 'object'
                                    ? JSON.stringify(value)
                                    : String(value)}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </Stack>
              </Paper>
            );
            })}
          </Stack>
        </Box>
      );
    }

    // Single statement error check (after multi-statement check)
    if (!data.success) {
      return (
        <Alert severity="error" icon={<ErrorIcon />}>
          <Typography variant="subtitle2">Execution Failed</Typography>
          <Typography variant="body2">{data.error}</Typography>
          <Typography variant="caption">Duration: {data.duration_ms}ms</Typography>
        </Alert>
      );
    }

    // Single statement result (original behavior)
    const rows = data.result?.rows || [];
    const rowCount = data.result?.rowCount || 0;

    return (
      <Box>
        {/* Success Header */}
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
          <Chip
            icon={<CheckCircleIcon />}
            label="Success"
            color="success"
            size="medium"
          />
          <Chip
            label={`${rowCount} row${rowCount !== 1 ? 's' : ''}`}
            color="primary"
            variant="outlined"
            size="medium"
            sx={{ fontWeight: 600, fontSize: '0.875rem' }}
          />
          <Chip
            label={`${data.duration_ms}ms`}
            color="default"
            variant="outlined"
            size="medium"
            sx={{ fontWeight: 600, fontSize: '0.875rem' }}
          />
          <Box sx={{ flexGrow: 1 }} />
          <Button
            size="small"
            startIcon={<DownloadIcon />}
            onClick={() => exportToCSV(rows, `${cloudName}-results.csv`)}
          >
            CSV
          </Button>
          <Button
            size="small"
            startIcon={<DownloadIcon />}
            onClick={() => exportToJSON(rows, `${cloudName}-results.json`)}
          >
            JSON
          </Button>
        </Stack>

        {/* Tabs */}
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="Table View" value="table" />
          <Tab label="JSON View" value="json" />
        </Tabs>

        {/* Table View */}
        {tab === 'table' && rows.length > 0 && (
          <TableContainer sx={{ maxHeight: 400 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {Object.keys(rows[0]).map((column) => (
                    <TableCell key={column} sx={{ fontWeight: 'bold' }}>
                      {column}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={index} hover>
                    {Object.values(row).map((value: any, cellIndex) => (
                      <TableCell key={cellIndex}>
                        {value === null
                          ? <em style={{ color: 'gray' }}>NULL</em>
                          : typeof value === 'object'
                          ? JSON.stringify(value)
                          : String(value)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {/* JSON View */}
        {tab === 'json' && (
          <Paper
            variant="outlined"
            sx={{
              p: 2,
              bgcolor: '#1e1e1e',
              color: '#d4d4d4',
              maxHeight: 400,
              overflow: 'auto',
            }}
          >
            <pre style={{ margin: 0, fontSize: '0.875rem' }}>
              {JSON.stringify(rows, null, 2)}
            </pre>
          </Paper>
        )}

        {rows.length === 0 && (
          <Alert severity="info">Query executed successfully but returned no rows</Alert>
        )}
      </Box>
    );
  };

  return (
    <Paper elevation={2} sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        Query Results
      </Typography>

      <Stack spacing={3}>
        {/* Render results for each cloud dynamically */}
        {cloudResults.map(({ cloudName, data }, index) => {
          const expanded = isCloudExpanded(cloudName);
          const color = index === 0 ? 'primary.main' : index === 1 ? 'secondary.main' : 'info.main';

          return (
            <Box key={cloudName}>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                onClick={() => toggleCloudExpanded(cloudName)}
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
                {renderResultView(
                  cloudName,
                  data,
                  getCloudTab(cloudName),
                  (tab) => setCloudTab(cloudName, tab)
                )}
              </Collapse>
            </Box>
          );
        })}

        {cloudResults.length === 0 && (
          <Alert severity="info">
            No cloud results available. The query may not have been executed yet.
          </Alert>
        )}
      </Stack>
    </Paper>
  );
};

export default ResultsPanel;
