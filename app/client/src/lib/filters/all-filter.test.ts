import { describe, test, expect } from 'vitest'
import { passesAllFilter } from './all-filter'
import { compileFilters } from './compile'
import type { Filter } from '@/types'

const ALL_FILTER: Filter = {
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

const POST_TOOL_BATCH_RAW = {
  id: 1,
  agentId: 'a',
  hookName: 'PostToolBatch',
  timestamp: 0,
  payload: {},
}

const PRE_TOOL_USE_RAW = {
  id: 2,
  agentId: 'a',
  hookName: 'PreToolUse',
  timestamp: 0,
  payload: { tool_name: 'Bash' },
}

describe('passesAllFilter', () => {
  test('returns true when default-all is not present (deleted)', () => {
    const compiled = compileFilters([])
    expect(passesAllFilter(POST_TOOL_BATCH_RAW, null, compiled)).toBe(true)
  })

  test('returns true when default-all is disabled', () => {
    const compiled = compileFilters([{ ...ALL_FILTER, enabled: false }])
    expect(passesAllFilter(POST_TOOL_BATCH_RAW, null, compiled)).toBe(true)
  })

  test('returns false for an event whose hook matches a negated pattern', () => {
    const compiled = compileFilters([ALL_FILTER])
    expect(passesAllFilter(POST_TOOL_BATCH_RAW, null, compiled)).toBe(false)
  })

  test('returns true for an event whose hook does not match any pattern', () => {
    const compiled = compileFilters([ALL_FILTER])
    expect(passesAllFilter(PRE_TOOL_USE_RAW, 'Bash', compiled)).toBe(true)
  })

  test('combines multiple patterns with AND (all exclusions must hold)', () => {
    const compiled = compileFilters([
      {
        ...ALL_FILTER,
        patterns: [
          { target: 'hook', regex: '^PostToolBatch$', negate: true },
          { target: 'hook', regex: '^Notification$', negate: true },
        ],
      },
    ])
    expect(passesAllFilter(POST_TOOL_BATCH_RAW, null, compiled)).toBe(false)
    expect(
      passesAllFilter(
        { ...PRE_TOOL_USE_RAW, hookName: 'Notification' },
        null,
        compiled,
      ),
    ).toBe(false)
    expect(passesAllFilter(PRE_TOOL_USE_RAW, 'Bash', compiled)).toBe(true)
  })
})
