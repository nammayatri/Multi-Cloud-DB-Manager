import { describe, it, expect } from 'vitest';
import { detectTargetFromSql } from './detectTarget';
import type { DbMap } from '../Selector/databaseTopology';

const meta = (schemas: string[]) => ({
  label: '',
  schemas,
  defaultSchema: schemas[0],
  clouds: [],
  replicationEnabled: false,
});

const dbMap: DbMap = {
  driver: meta(['atlas_driver_offer_bpp']),
  rider: meta(['atlas_app']),
  dashboard: meta(['atlas_bpp_dashboard', 'atlas_bap_dashboard']),
};

describe('detectTargetFromSql', () => {
  it('maps a qualified table to the database owning its schema', () => {
    expect(detectTargetFromSql('SELECT * FROM atlas_app.booking WHERE id = 1', dbMap)).toEqual({
      database: 'rider',
      pgSchema: 'atlas_app',
      schemas: ['atlas_app'],
    });
  });

  it('ignores table aliases and unqualified SQL', () => {
    expect(detectTargetFromSql('SELECT b.id FROM booking b', dbMap)).toBeNull();
    expect(
      detectTargetFromSql('SELECT b.id FROM atlas_driver_offer_bpp.booking b', dbMap)?.database
    ).toBe('driver');
  });

  it('handles quoted and mixed-case schemas', () => {
    expect(detectTargetFromSql('UPDATE "atlas_app"."person" SET x = 1', dbMap)?.database).toBe('rider');
    expect(detectTargetFromSql('select * from ATLAS_APP.person', dbMap)?.database).toBe('rider');
  });

  it('does not count schemas in strings or comments', () => {
    expect(detectTargetFromSql("SELECT 'atlas_app.x' FROM t -- atlas_app.y", dbMap)).toBeNull();
  });

  it('keeps the database but not one schema when several of its schemas are used', () => {
    expect(
      detectTargetFromSql('SELECT * FROM atlas_bpp_dashboard.a JOIN atlas_bap_dashboard.b ON true', dbMap)
    ).toEqual({ database: 'dashboard', pgSchema: undefined, schemas: ['atlas_bpp_dashboard', 'atlas_bap_dashboard'] });
  });

  it('gives up when the schemas belong to different databases', () => {
    expect(
      detectTargetFromSql('SELECT * FROM atlas_app.a, atlas_driver_offer_bpp.b', dbMap)
    ).toBeNull();
  });

  it('gives up when a schema is shared by several databases', () => {
    const shared: DbMap = { ...dbMap, rider2: meta(['atlas_app']) };
    expect(detectTargetFromSql('SELECT * FROM atlas_app.a', shared)).toBeNull();
  });
});
