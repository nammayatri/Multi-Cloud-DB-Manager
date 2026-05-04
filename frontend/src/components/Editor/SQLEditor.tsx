import React from 'react';
import { Editor } from '@monaco-editor/react';
import { Box, Paper, Button, Stack, Typography, IconButton, Tooltip } from '@mui/material';
import FormatAlignLeftIcon from '@mui/icons-material/FormatAlignLeft';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import { useAppStore } from '../../store/appStore';
import type { editor } from 'monaco-editor';
import { KeyMod, KeyCode } from 'monaco-editor';
import { format } from 'sql-formatter';
import toast from 'react-hot-toast';
import { useAutoSave } from '../../hooks/useAutoSave';
import { formatDistanceToNow } from 'date-fns';

const SQLEditor = () => {
  const currentQuery = useAppStore(s => s.currentQuery);
  const setCurrentQuery = useAppStore(s => s.setCurrentQuery);
  const setEditorInstance = useAppStore(s => s.setEditorInstance);
  const executeRef = useAppStore(s => s.executeRef);
  const { lastSaved, isSaving, clearDraft } = useAutoSave();

  const handleEditorDidMount = (editorInstance: editor.IStandaloneCodeEditor) => {
    setEditorInstance(editorInstance);

    // Multiple <SQLEditor> instances can be mounted at once (e.g. one in the
    // DB Manager panel, one in the Clickhouse Manager panel — both panels
    // stay in the DOM behind opacity:0 / display:none). They all share the
    // same editorInstance slot in Zustand, so the last to mount silently
    // wins. Make the *focused* editor the source of truth: whenever the user
    // clicks/types into an editor it claims the slot back. getQueryToExecute
    // therefore always reads the editor the user is actually using.
    editorInstance.onDidFocusEditorWidget(() => {
      setEditorInstance(editorInstance);
    });

    // Cmd+Enter / Ctrl+Enter to execute query
    editorInstance.addAction({
      id: 'execute-query',
      label: 'Execute Query',
      keybindings: [KeyMod.CtrlCmd | KeyCode.Enter],
      run: () => {
        executeRef.current?.();
      },
    });
  };

  const handleGenerateUUID = () => {
    const editorInstance = useAppStore.getState().editorInstance;
    const uuid = crypto.randomUUID();
    if (editorInstance) {
      const position = editorInstance.getPosition();
      if (position) {
        editorInstance.executeEdits('insert-uuid', [{
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          text: `'${uuid}'`,
        }]);
        editorInstance.focus();
        return;
      }
    }
    // Fallback: copy to clipboard
    navigator.clipboard.writeText(uuid);
    toast.success(`UUID copied: ${uuid}`);
  };

  const handleFormatSQL = () => {
    try {
      if (!currentQuery.trim()) {
        toast.error('No query to format');
        return;
      }

      const formatted = format(currentQuery, {
        language: 'postgresql',
        tabWidth: 2,
        keywordCase: 'upper',
        linesBetweenQueries: 2,
      });

      setCurrentQuery(formatted);
      toast.success('SQL formatted successfully');
    } catch (error) {
      toast.error('Failed to format SQL. Check for syntax errors.');
    }
  };

  const getDraftStatus = () => {
    if (isSaving) {
      return 'Saving...';
    }
    if (lastSaved) {
      return `Draft saved ${formatDistanceToNow(lastSaved, { addSuffix: true })}`;
    }
    return null;
  };

  return (
    <Paper elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={<FormatAlignLeftIcon />}
          onClick={handleFormatSQL}
        >
          Format SQL
        </Button>

        <Tooltip title="Insert a pre-generated UUID literal at cursor position">
          <Button
            variant="outlined"
            size="small"
            startIcon={<FingerprintIcon />}
            onClick={handleGenerateUUID}
          >
            Generate UUID
          </Button>
        </Tooltip>

        <Box sx={{ flexGrow: 1 }} />

        {/* Draft status indicator */}
        {getDraftStatus() && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
              {getDraftStatus()}
            </Typography>
            {lastSaved && (
              <Tooltip title="Clear draft">
                <IconButton size="small" onClick={clearDraft} sx={{ p: 0.5 }}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        )}
      </Stack>
      <Box sx={{ flexGrow: 1, p: 0, minHeight: 0 }}>
        <Editor
          height="100%"
          defaultLanguage="sql"
          value={currentQuery}
          onChange={(value) => setCurrentQuery(value || '')}
          onMount={handleEditorDidMount}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            formatOnPaste: true,
            formatOnType: true,
            suggest: {
              showKeywords: true,
              showSnippets: true,
            },
            scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
              handleMouseWheel: true,
              alwaysConsumeMouseWheel: false,
            },
          }}
        />
      </Box>
    </Paper>
  );
};

export default React.memo(SQLEditor);
