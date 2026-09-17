import { Box } from '@mui/material';
import type { Role } from '../../constants/roles';
import { DB_ROLES, REDIS_ROLES } from '../Navigation/consoleSections';
import QueryHistory from './QueryHistory';
import RedisHistory from '../Redis/RedisHistory';

/**
 * Admin → History: query and Redis history side by side. Each panel follows the
 * access of the page it records, so a role without Redis (e.g. REQUESTOR) gets
 * query history at full width.
 */
const HistoryPage = ({ role, active }: { role: Role; active: boolean }) => {
  const showQuery = DB_ROLES.includes(role);
  const showRedis = REDIS_ROLES.includes(role);

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        p: 1,
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', md: showQuery && showRedis ? '1fr 1fr' : '1fr' },
        gridAutoRows: { xs: 'minmax(480px, 1fr)', md: 'minmax(0, 1fr)' },
        overflowY: { xs: 'auto', md: 'hidden' },
      }}
    >
      {showQuery && <QueryHistory active={active} />}
      {showRedis && <RedisHistory active={active} />}
    </Box>
  );
};

export default HistoryPage;
