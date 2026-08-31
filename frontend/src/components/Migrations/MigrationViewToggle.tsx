import React from 'react';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useAppStore, type MigrationView } from '../../store/appStore';

/**
 * Switches the Migrations tab between the Verifier and the Lite Runner.
 * Rendered inside each panel's own toolbar rather than on a row of its own,
 * so it costs no vertical space.
 */
const MigrationViewToggle = ({ disabled }: { disabled?: boolean }) => {
  const migrationView = useAppStore((s) => s.migrationView);
  const setMigrationView = useAppStore((s) => s.setMigrationView);

  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={migrationView}
      onChange={(_e, value: MigrationView | null) => value && setMigrationView(value)}
      disabled={disabled}
      aria-label="Migrations view"
      sx={{ flexShrink: 0, '& .MuiToggleButton-root': { px: 1.5, py: 0.5, whiteSpace: 'nowrap' } }}
    >
      <ToggleButton value="verifier">Verifier</ToggleButton>
      <ToggleButton value="lite">Lite Runner</ToggleButton>
    </ToggleButtonGroup>
  );
};

export default React.memo(MigrationViewToggle);
