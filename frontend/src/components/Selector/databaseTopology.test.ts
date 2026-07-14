import { describe, it, expect } from 'vitest';
import { buildDbMap, buildModesForDb } from './databaseTopology';
import type { DatabaseConfiguration } from '../../types';

// A config exercising all topologies:
//   - multi:         gcp (primary, pub) + aws (secondary, sub) + azure (secondary, sub) → multi-cloud, replicated
//   - onlyprimary:   gcp (primary) only                                                → single-cloud
//   - onlysecondary: aws (secondary) only                                              → single-cloud
//   - onlyazure:     azure (secondary) only                                            → single-cloud
const config: DatabaseConfiguration = {
  primary: {
    cloudName: 'gcp',
    databases: [
      { name: 'multi', label: 'Multi', cloudType: 'gcp', schemas: ['public'], defaultSchema: 'public', publicationName: 'multi_pub' },
      { name: 'onlyprimary', label: 'Primary Only', cloudType: 'gcp', schemas: ['public'], defaultSchema: 'public' },
    ],
  },
  secondary: [
    {
      cloudName: 'aws',
      databases: [
        { name: 'multi', label: 'Multi', cloudType: 'aws', schemas: ['public'], defaultSchema: 'public', subscriptionName: 'multi_sub' },
        { name: 'onlysecondary', label: 'Secondary Only', cloudType: 'aws', schemas: ['public'], defaultSchema: 'public' },
      ],
    },
    {
      cloudName: 'azure',
      databases: [
        { name: 'multi', label: 'Multi', cloudType: 'azure', schemas: ['public'], defaultSchema: 'public', subscriptionName: 'multi_sub_azure' },
        { name: 'onlyazure', label: 'Azure Only', cloudType: 'azure', schemas: ['public'], defaultSchema: 'public' },
      ],
    },
  ],
} as unknown as DatabaseConfiguration;

describe('buildDbMap', () => {
  const map = buildDbMap(config);

  it('lists the union of all database names across every cloud', () => {
    expect(Object.keys(map).sort()).toEqual(['multi', 'onlyazure', 'onlyprimary', 'onlysecondary']);
  });

  it('groups a multi-cloud database across all its clouds, primary first', () => {
    expect(map.multi.clouds.map(c => c.cloudType)).toEqual(['gcp', 'aws', 'azure']);
    expect(map.multi.clouds.map(c => c.role)).toEqual(['primary', 'secondary', 'secondary']);
  });

  it('marks replicationEnabled only when there is a primary publisher AND a secondary subscriber', () => {
    expect(map.multi.replicationEnabled).toBe(true);
    expect(map.onlyprimary.replicationEnabled).toBe(false); // publisher but no subscriber
    expect(map.onlysecondary.replicationEnabled).toBe(false); // subscriber but no publisher
    expect(map.onlyazure.replicationEnabled).toBe(false);
  });

  it('keeps single-cloud databases on exactly one cloud', () => {
    expect(map.onlyprimary.clouds.map(c => c.cloudType)).toEqual(['gcp']);
    expect(map.onlysecondary.clouds.map(c => c.cloudType)).toEqual(['aws']);
    expect(map.onlyazure.clouds.map(c => c.cloudType)).toEqual(['azure']);
  });
});

describe('buildModesForDb', () => {
  const map = buildDbMap(config);

  it('offers Multi-Cloud + each cloud for a multi-cloud database', () => {
    const modes = buildModesForDb(map.multi).map(m => m.value);
    expect(modes).toEqual(['both', 'gcp', 'aws', 'azure']);
  });

  it('uses config cloud names (not hardcoded) in the multi-cloud label', () => {
    const both = buildModesForDb(map.multi).find(m => m.value === 'both');
    expect(both?.label).toBe('Multi-Cloud (GCP + AWS + AZURE)');
  });

  it('offers only the single cloud (no Multi-Cloud) for a primary-only database', () => {
    expect(buildModesForDb(map.onlyprimary).map(m => m.value)).toEqual(['gcp']);
  });

  it('offers only the single cloud for a secondary-only database', () => {
    expect(buildModesForDb(map.onlysecondary).map(m => m.value)).toEqual(['aws']);
    expect(buildModesForDb(map.onlyazure).map(m => m.value)).toEqual(['azure']);
  });

  it('returns no modes for an unknown database', () => {
    expect(buildModesForDb(undefined)).toEqual([]);
  });
});

describe('buildDbMap with per-database primary clouds (databasesByName)', () => {
  // Driver is aws-primary + gcp-secondary; Rider is gcp-primary — DIFFERENT
  // primary clouds per database. This is only representable via databasesByName.
  const perDbConfig = {
    databasesByName: {
      Bpp: {
        clouds: [
          { cloudType: 'aws', role: 'primary', label: 'Driver', schemas: ['public'], defaultSchema: 'public', publicationName: 'bpp_pub' },
          { cloudType: 'gcp', role: 'secondary', label: 'Driver', schemas: ['public'], defaultSchema: 'public', subscriptionName: 'bpp_sub' },
        ],
      },
      Bap: {
        clouds: [
          { cloudType: 'gcp', role: 'primary', label: 'Rider', schemas: ['public'], defaultSchema: 'public' },
        ],
      },
    },
    // legacy blocks present but should be IGNORED in favor of databasesByName
    primary: { cloudName: 'aws', databases: [] },
    secondary: [],
  } as unknown as DatabaseConfiguration;

  const map = buildDbMap(perDbConfig);

  it('uses databasesByName and gives each DB its own primary cloud', () => {
    expect(map.Bpp.clouds.map(c => `${c.cloudType}:${c.role}`)).toEqual(['aws:primary', 'gcp:secondary']);
    expect(map.Bap.clouds.map(c => `${c.cloudType}:${c.role}`)).toEqual(['gcp:primary']);
  });

  it('marks the multi-cloud DB with a subscriber as replication-enabled, single-cloud not', () => {
    expect(map.Bpp.replicationEnabled).toBe(true);
    expect(map.Bap.replicationEnabled).toBe(false);
  });

  it('offers Multi-Cloud for the multi-cloud DB and single mode for the other', () => {
    expect(buildModesForDb(map.Bpp).map(m => m.value)).toEqual(['both', 'aws', 'gcp']);
    expect(buildModesForDb(map.Bap).map(m => m.value)).toEqual(['gcp']);
  });
});
