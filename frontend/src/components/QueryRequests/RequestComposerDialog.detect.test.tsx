import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RequestComposerDialog from './RequestComposerDialog';
import type { DbMap } from '../Selector/databaseTopology';

const create = vi.fn();

const meta = (schemas: string[]) => ({
  label: '',
  schemas,
  defaultSchema: schemas[0],
  clouds: [{ cloudType: 'cloud1', role: 'primary' as const }],
  replicationEnabled: false,
});

const dbMap: DbMap = {
  driver: meta(['atlas_driver_offer_bpp']),
  rider: meta(['atlas_app']),
};

vi.mock('../../services/api', () => ({
  queryRequestsAPI: { create: (...args: unknown[]) => create(...args) },
  toastNonApiError: vi.fn(),
}));

// Real target logic, but with a fixed topology and no dropdowns to render.
vi.mock('./queryTargets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queryTargets')>()),
  useDatabaseTopology: () => ({ dbMap, loading: false }),
  QueryTargetSelects: () => null,
}));

vi.mock('../Editor/SQLEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="SQL" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const submit = () => {
  fireEvent.change(screen.getByLabelText(/why does this need to run/i), { target: { value: 'Ticket' } });
  fireEvent.click(screen.getByRole('button', { name: /submit request/i }));
};

describe('RequestComposerDialog target detection', () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ groupId: 'g', requests: [] });
  });

  it('moves a console prefill to the database the SQL names', async () => {
    render(
      <RequestComposerDialog
        open
        onClose={() => {}}
        initialItems={[
          { query: 'SELECT * FROM atlas_app.booking', database: 'driver', mode: 'cloud1', pgSchema: 'atlas_driver_offer_bpp' },
        ]}
      />
    );
    submit();
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].items[0]).toMatchObject({ database: 'rider', pgSchema: 'atlas_app' });
  });

  it('leaves the target empty, and refuses to submit, when the SQL names no schema', async () => {
    render(
      <RequestComposerDialog
        open
        onClose={() => {}}
        initialItems={[{ query: 'SELECT * FROM booking', database: 'driver', mode: 'cloud1', pgSchema: 'atlas_driver_offer_bpp' }]}
      />
    );
    submit();
    expect(await screen.findByText(/pick the database, execution mode and schema/i)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it('follows the SQL as it is typed into a new request', async () => {
    render(<RequestComposerDialog open onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('SQL'), {
      target: { value: 'UPDATE atlas_app.person SET first_name = first_name' },
    });
    expect(screen.getByText(/target picked from the query/i)).toBeTruthy();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].items[0]).toMatchObject({ database: 'rider', pgSchema: 'atlas_app' });
  });
});
