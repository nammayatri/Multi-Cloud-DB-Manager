import React, { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Paper,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  Button,
  Stack,
  Typography,
  CircularProgress,
  Autocomplete,
  Chip,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { useAppStore } from '../../store/appStore';
import { redisAPI, schemaAPI } from '../../services/api';
import { ALL_STRUCTURED_COMMANDS, RAW_COMMAND, getCommandDefinition } from './RedisCommandDefinitions';
import toast from 'react-hot-toast';
import type { RedisCommandResponse, RedisCommandDefinition, DatabaseConfiguration } from '../../types';

interface RedisCommandFormProps {
  onResult: (result: RedisCommandResponse) => void;
}

// Patterns blocked for all users (match backend BLOCKED_KEY_PATTERNS)
const BLOCKED_KEY_RE = /^(\*{1,2}|\?)$/;

const RedisCommandForm = ({ onResult }: RedisCommandFormProps) => {
  const user = useAppStore(s => s.user);
  const [selectedCommand, setSelectedCommand] = useState('GET');
  const [selectedCloud, setSelectedCloud] = useState('both');
  const [args, setArgs] = useState<Record<string, string>>({});
  const [isExecuting, setIsExecuting] = useState(false);
  const [cloudNames, setCloudNames] = useState<string[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(true);

  const isReader = user?.role === 'READER';
  const isMaster = user?.role === 'MASTER';
  const commandDef = getCommandDefinition(selectedCommand);
  const isWriteCommand = commandDef?.isWrite ?? false;
  const isRawCommand = selectedCommand === 'RAW';

  // Build available commands based on role
  const availableCommands = useMemo(() => {
    const cmds: RedisCommandDefinition[] = [...ALL_STRUCTURED_COMMANDS];
    if (isMaster) {
      cmds.push(RAW_COMMAND);
    }
    return cmds;
  }, [isMaster]);

  // Find the currently selected definition for Autocomplete value
  const selectedDef = useMemo(() => {
    return availableCommands.find((c) => c.command === selectedCommand) || availableCommands[0];
  }, [selectedCommand, availableCommands]);

  // Fetch cloud names from configuration
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const config: DatabaseConfiguration = await schemaAPI.getConfiguration();
        const clouds = [
          config.primary.cloudName,
          ...config.secondary.map((s) => s.cloudName),
        ];
        setCloudNames(clouds);
      } catch (error) {
        console.error('Failed to load configuration:', error);
        setCloudNames(['aws', 'gcp']);
      } finally {
        setLoadingConfig(false);
      }
    };
    fetchConfig();
  }, []);

  // Reset args when command changes
  useEffect(() => {
    if (commandDef) {
      const defaults: Record<string, string> = {};
      for (const field of commandDef.fields) {
        defaults[field.name] = field.default || '';
      }
      setArgs(defaults);
    }
  }, [selectedCommand]);

  const handleArgChange = (name: string, value: string) => {
    setArgs((prev) => ({ ...prev, [name]: value }));
  };

  const handleExecute = async () => {
    if (!commandDef) return;

    // Validate required fields
    for (const field of commandDef.fields) {
      if (field.required && !args[field.name]?.trim()) {
        toast.error(`${field.label} is required`);
        return;
      }
    }

    // Block wildcard-only key patterns for all users (non-RAW commands)
    if (!isRawCommand && args.key && BLOCKED_KEY_RE.test(args.key.trim())) {
      toast.error('Wildcard-only key patterns (e.g., "*") are blocked. Use a specific key or SCAN with a pattern.');
      return;
    }

    setIsExecuting(true);
    try {
      const result = await redisAPI.executeCommand({
        command: selectedCommand,
        args,
        cloud: selectedCloud,
      });
      onResult(result);
      toast.success('Command executed');
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Command execution failed');
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <Paper elevation={2} sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={2} alignItems="center">
          {/* Searchable Command Selector */}
          <Autocomplete
            value={selectedDef}
            onChange={(_, newValue) => {
              if (newValue) {
                setSelectedCommand(newValue.command);
              }
            }}
            options={availableCommands}
            groupBy={(option) => {
              if (option.isWrite) return `${option.category} (Write)`;
              return `${option.category} (Read)`;
            }}
            getOptionLabel={(option) => option.label}
            renderOption={(props, option) => (
              <li {...props} key={option.command}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                    {option.label}
                  </Typography>
                  {option.isWrite && (
                    <Chip label="W" size="small" color="warning" sx={{ height: 18, fontSize: 10 }} />
                  )}
                  {isReader && option.isWrite && (
                    <Typography variant="caption" color="error" sx={{ ml: 'auto' }}>
                      No access
                    </Typography>
                  )}
                </Stack>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Command"
                size="small"
                placeholder="Search commands..."
              />
            )}
            disableClearable
            isOptionEqualToValue={(option, value) => option.command === value.command}
            getOptionDisabled={(option) => isReader && option.isWrite}
            sx={{ minWidth: 280 }}
            disabled={isExecuting}
          />

          {/* Cloud Selector */}
          <FormControl sx={{ minWidth: 180 }} size="small">
            <InputLabel>Cloud</InputLabel>
            <Select
              value={selectedCloud}
              label="Cloud"
              onChange={(e) => setSelectedCloud(e.target.value)}
              disabled={isExecuting || loadingConfig}
            >
              <MenuItem value="both">
                All Clouds ({cloudNames.map((c) => c.toUpperCase()).join(' + ')})
              </MenuItem>
              {cloudNames.map((cloud) => (
                <MenuItem key={cloud} value={cloud}>
                  {cloud.toUpperCase()} Only
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Box sx={{ flexGrow: 1 }} />

          {/* Execute Button */}
          <Button
            variant="contained"
            color="success"
            size="large"
            startIcon={isExecuting ? <CircularProgress size={20} color="inherit" /> : <PlayArrowIcon />}
            onClick={handleExecute}
            disabled={isExecuting || (isReader && isWriteCommand) || (isRawCommand && !isMaster)}
            sx={{ minWidth: 150 }}
          >
            {isExecuting ? 'Running...' : 'Execute'}
          </Button>
        </Stack>

        {/* Dynamic form fields */}
        {commandDef && commandDef.fields.length > 0 && (
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            {commandDef.fields.map((field) => (
              <TextField
                key={field.name}
                label={field.label}
                value={args[field.name] || ''}
                onChange={(e) => handleArgChange(field.name, e.target.value)}
                required={field.required}
                disabled={isExecuting}
                size="small"
                sx={{ minWidth: isRawCommand ? 400 : 200, flex: 1 }}
                placeholder={field.default ? `Default: ${field.default}` : undefined}
                multiline={isRawCommand || field.name === 'pairs' || field.name === 'fields'}
                maxRows={3}
              />
            ))}
          </Stack>
        )}

        {isReader && isWriteCommand && (
          <Typography variant="caption" color="error">
            READER role cannot execute write commands
          </Typography>
        )}

        {isRawCommand && (
          <Typography variant="caption" color="warning.main">
            RAW mode sends any Redis command directly. Dangerous commands (EVAL, FLUSHALL, SUBSCRIBE, CLUSTER, CONFIG, etc.) are blocked.
          </Typography>
        )}
      </Stack>
    </Paper>
  );
};

export default React.memo(RedisCommandForm);
