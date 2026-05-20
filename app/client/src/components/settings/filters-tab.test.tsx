import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FiltersTab } from './filters-tab'
import { useFilterStore } from '@/stores/filter-store'
import type { Filter } from '@/types'

vi.mock('@/lib/api-client', () => ({
  api: {
    listFilters: vi.fn().mockResolvedValue([]),
    createFilter: vi.fn(async (input) => ({
      id: 'new',
      ...input,
      // Server always returns the parsed config; mirror that here so the
      // FilterEditor doesn't crash dereferencing `config.color`.
      config: input.config ?? {},
      kind: 'user',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    })),
    updateFilter: vi.fn(),
    deleteFilter: vi.fn(),
    duplicateFilter: vi.fn(),
    resetDefaultFilters: vi.fn(),
  },
}))

// FiltersTab renders LivePreview, which calls useQueryClient(). Wrap the
// render in a QueryClientProvider so the hook resolves to a real client.
function renderWithQuery(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('FiltersTab', () => {
  beforeEach(() => {
    useFilterStore.setState({ filters: [], compiled: [], loaded: false, dirty: false })
  })

  test('clicking + New filter creates a user filter and selects it', async () => {
    renderWithQuery(<FiltersTab />)
    // Wait for load() to complete (mocked empty list).
    await act(async () => {})

    fireEvent.click(screen.getByText('+ New filter'))
    await act(async () => {})

    expect(screen.getByText('New filter')).toBeInTheDocument()
    // User filters render Save / Delete buttons; default filters don't.
    // Use the latter as a proxy that this is opened as a user filter.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })
})

const defaultAll: Filter = {
  id: 'default-all',
  name: 'All',
  pillName: 'All',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PostToolBatch$', negate: true }],
  kind: 'default',
  enabled: true,
  config: { role: 'all-exclusions' },
  createdAt: 0,
  updatedAt: 0,
}

const defaultTools: Filter = {
  id: 'default-tools',
  name: 'Tools',
  pillName: 'Tools',
  display: 'primary',
  combinator: 'and',
  patterns: [{ target: 'hook', regex: '^PreToolUse$' }],
  kind: 'default',
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

describe('FiltersTab — All filter', () => {
  beforeEach(() => {
    // Pre-load filters so the component skips its load() effect. Put
    // tools FIRST in the array to prove the sort puts All first regardless
    // of the input order.
    useFilterStore.setState({
      filters: [defaultTools, defaultAll],
      compiled: [],
      loaded: true,
      dirty: false,
    })
  })

  test('renders default-all first in the Primary filter list', () => {
    renderWithQuery(<FiltersTab />)
    // The sidebar list renders filter names as text. Find the All and
    // Tools labels and assert order. Use `getAllByText` to handle any
    // duplicate-name accident; the first occurrence is the list row.
    const allLabel = screen.getAllByText('All')[0]
    const toolsLabel = screen.getAllByText('Tools')[0]
    // DOCUMENT_POSITION_FOLLOWING = 0x04
    expect(
      // eslint-disable-next-line no-bitwise
      allLabel.compareDocumentPosition(toolsLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  test('shows the All-filter caption above the default-all row', () => {
    renderWithQuery(<FiltersTab />)
    expect(
      screen.getByText(/Hides events from the timeline and event stream/i),
    ).toBeInTheDocument()
  })

  test('hides Display, Combinator, and Color controls when editing default-all', () => {
    renderWithQuery(<FiltersTab />)
    fireEvent.click(screen.getAllByText('All')[0])
    // The editor renders "Display", "Combinator", and "Color" as labels
    // for the existing controls. For default-all, all three should be
    // hidden.
    expect(screen.queryByText(/^Display$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Combinator$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Color$/)).not.toBeInTheDocument()
  })

  test('defaults new pattern rows to negate=true when editing default-all', () => {
    renderWithQuery(<FiltersTab />)
    fireEvent.click(screen.getAllByText('All')[0])
    // Editor opens with one negated pattern (the PostToolBatch seed).
    // The `!` button visible next to a pattern's regex input indicates
    // it's negated.
    const negatedBefore = screen.queryAllByTitle(/Negated/i).length
    fireEvent.click(screen.getByText('+ Add pattern'))
    const negatedAfter = screen.queryAllByTitle(/Negated/i).length
    expect(negatedAfter).toBe(negatedBefore + 1)
  })
})
