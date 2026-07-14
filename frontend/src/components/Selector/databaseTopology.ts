import type { DatabaseConfiguration, DatabaseInfo } from '../../types';

// -------------------------------------------------------------------------
// Database topology helpers
// -------------------------------------------------------------------------
// Pure functions that turn the flat /config response (primary + secondary)
// into a per-database view keyed by database name. This is what drives the
// per-database Execution Mode options and the replication prompt, so a
// database that lives on only one cloud offers just that cloud (no
// "Multi-Cloud" option) and is never prompted for replication.

export interface ExecutionModeOption {
  value: string;
  label: string;
  cloudName: string;
}

export interface DbCloudEntry {
  cloudType: string;
  role: 'primary' | 'secondary';
  publicationName?: string;
  subscriptionName?: string;
}

export interface DbMeta {
  label: string;
  schemas: string[];
  defaultSchema: string;
  clouds: DbCloudEntry[]; // primary first, then secondaries (in config order)
  replicationEnabled: boolean; // primary publication AND ≥1 secondary subscription
}

export type DbMap = Record<string, DbMeta>;

/**
 * Group the flat primary/secondary config into a map keyed by database name.
 * A database appears once per cloud it's configured on; single-cloud databases
 * simply have one entry in `clouds`.
 */
export function buildDbMap(config: DatabaseConfiguration): DbMap {
  const map: DbMap = {};

  const addDb = (db: DatabaseInfo, role: 'primary' | 'secondary', cloudName: string) => {
    if (!map[db.name]) {
      map[db.name] = {
        label: db.label,
        schemas: db.schemas,
        defaultSchema: db.defaultSchema,
        clouds: [],
        replicationEnabled: false,
      };
    }
    map[db.name].clouds.push({
      cloudType: db.cloudType || cloudName,
      role,
      publicationName: db.publicationName,
      subscriptionName: db.subscriptionName,
    });
  };

  config.primary.databases.forEach(db => addDb(db, 'primary', config.primary.cloudName));
  config.secondary.forEach(cloud =>
    cloud.databases.forEach(db => addDb(db, 'secondary', cloud.cloudName))
  );

  // Replication only makes sense for a genuinely multi-cloud database: it needs
  // a publisher on the primary AND at least one subscriber on a secondary.
  Object.values(map).forEach(meta => {
    const hasPublisher = meta.clouds.some(c => c.role === 'primary' && !!c.publicationName);
    const hasSubscriber = meta.clouds.some(c => c.role === 'secondary' && !!c.subscriptionName);
    meta.replicationEnabled = hasPublisher && hasSubscriber;
  });

  return map;
}

/** Build the Execution Mode options for a single database from its clouds. */
export function buildModesForDb(meta: DbMeta | undefined): ExecutionModeOption[] {
  if (!meta || meta.clouds.length === 0) return [];
  const cloudTypes = meta.clouds.map(c => c.cloudType);
  const modes: ExecutionModeOption[] = [];

  // Offer the multi-cloud option only when the DB actually spans >1 cloud.
  if (cloudTypes.length > 1) {
    const allClouds = cloudTypes.map(c => c.toUpperCase()).join(' + ');
    modes.push({ value: 'both', label: `Multi-Cloud (${allClouds})`, cloudName: 'both' });
  }
  cloudTypes.forEach(cloud => {
    modes.push({ value: cloud, label: `${cloud.toUpperCase()} Only`, cloudName: cloud });
  });
  return modes;
}
