import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

export interface LeanFlowFeaturesConfig {
  driver: string[];
  rider: string[];
}

// Baked-in fallback so the panel still works if the config file is ever
// missing or unreadable. Kept in sync by hand with
// Domain.Types.Extra.LeanFlow.LeanFlowFeature in both nammayatri repos.
const DEFAULT_CONFIG: LeanFlowFeaturesConfig = {
  driver: [
    'LEADERBOARD',
    'REFERRAL',
    'RIDE_INTERPOLATION',
    'FLEET_OPERATOR_STATS',
    'GPS_TOLL_BEHAVIOR',
    'RC_STATS_REMINDERS',
    'RIDE_END_NOTIFICATIONS',
    'DRIVER_CITY_MIGRATION',
    'ANALYTICS_KAFKA',
    'SUPPLY_DEMAND',
    'CONGESTION_CHARGE',
    'DRIVER_COINS',
    'DEMAND_HOTSPOTS',
    'NAMMA_TAG_CHAKRA',
    'DYNAMIC_PRICING',
  ],
  rider: ['WALK_AND_SAVE', 'HOTSPOT', 'REWARD_INFLIGHT_RECONCILE', 'FRFS_SEAT_HOLD_REAPER', 'NAMMA_TAG_CHAKRA'],
};

const isValidShape = (value: unknown): value is LeanFlowFeaturesConfig =>
  !!value &&
  typeof value === 'object' &&
  Array.isArray((value as any).driver) &&
  Array.isArray((value as any).rider) &&
  (value as any).driver.every((f: unknown) => typeof f === 'string') &&
  (value as any).rider.every((f: unknown) => typeof f === 'string');

/**
 * Loads the known lean_flow feature names shown as checkboxes in the System
 * Configs panel. Re-read on every call (not cached) so editing a mounted
 * ConfigMap takes effect without a backend restart.
 *
 * Priority: Kubernetes ConfigMap mount -> local repo file -> baked-in default.
 */
export function loadLeanFlowFeaturesConfig(): LeanFlowFeaturesConfig {
  const k8sConfigPath = '/config/leanFlowFeatures.json';
  if (fs.existsSync(k8sConfigPath)) {
    const fromK8s = readJsonFile(k8sConfigPath);
    if (fromK8s) return fromK8s;
  }

  const localConfigPath = path.join(__dirname, '../../config/leanFlowFeatures.json');
  if (fs.existsSync(localConfigPath)) {
    const fromLocal = readJsonFile(localConfigPath);
    if (fromLocal) return fromLocal;
  }

  logger.warn('leanFlowFeatures.json not found in any location, using baked-in default feature list');
  return DEFAULT_CONFIG;
}

function readJsonFile(filePath: string): LeanFlowFeaturesConfig | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isValidShape(parsed)) {
      logger.error('leanFlowFeatures.json has an invalid shape, expected { driver: string[], rider: string[] }', { path: filePath });
      return null;
    }
    return parsed;
  } catch (error) {
    logger.error('Failed to read/parse leanFlowFeatures.json', { path: filePath, error });
    return null;
  }
}
