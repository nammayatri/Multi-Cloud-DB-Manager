import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RequestComposerDialog from './RequestComposerDialog';

const GROUP_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const create = vi.fn();

vi.mock('../../services/api', () => ({
  queryRequestsAPI: {
    create: (...args: unknown[]) => create(...args),
  },
  toastNonApiError: vi.fn(),
}));

// The target selects fetch the database topology on mount; the composer's
// confirmation has nothing to do with them.
vi.mock('./queryTargets', () => ({
  useDatabaseTopology: () => ({ dbMap: { mydb: {} }, loading: false }),
  defaultTargetFor: () => ({ database: 'mydb', mode: 'cloud1', pgSchema: 'public' }),
  firstDatabase: () => 'mydb',
  QueryTargetSelects: () => null,
}));

vi.mock('../Editor/SQLEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="SQL" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

/** Fill in the two required fields and submit. */
const submitARequest = () => {
  fireEvent.change(screen.getByLabelText(/why does this need to run/i), {
    target: { value: 'Ticket NY-4821' },
  });
  fireEvent.change(screen.getByLabelText('SQL'), {
    target: { value: 'SELECT 1' },
  });
  fireEvent.click(screen.getByRole('button', { name: /submit request/i }));
};

describe('RequestComposerDialog, once a request is raised', () => {
  const writeText = vi.fn();
  let originalClipboard: typeof navigator.clipboard;

  beforeEach(() => {
    create.mockResolvedValue({ groupId: GROUP_ID, requests: [] });
    originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
    vi.clearAllMocks();
  });

  it('stays open and offers the link to the new request', async () => {
    render(<RequestComposerDialog open onClose={vi.fn()} />);
    submitARequest();

    expect(await screen.findByText('Request submitted')).toBeInTheDocument();
    expect(screen.getByLabelText(/link to this request/i)).toHaveValue(
      `${window.location.origin}/?request=${GROUP_ID}`
    );
  });

  it('copies that link', async () => {
    render(<RequestComposerDialog open onClose={vi.fn()} />);
    submitARequest();

    fireEvent.click(await screen.findByRole('button', { name: /copy link/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?request=${GROUP_ID}`)
    );
  });

  // The list behind has to refresh while this dialog is still up, or closing it
  // would drop you on a list that doesn't show what you just raised.
  it('tells its caller the group id before it is closed', async () => {
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    render(<RequestComposerDialog open onClose={onClose} onSubmitted={onSubmitted} />);
    submitARequest();

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(GROUP_ID));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not reach the confirmation when the request is refused', async () => {
    create.mockRejectedValue({ isAxiosError: true, response: { status: 403 } });
    render(<RequestComposerDialog open onClose={vi.fn()} />);
    submitARequest();

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(screen.queryByText('Request submitted')).not.toBeInTheDocument();
  });
});
