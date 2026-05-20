import type { RawEvent } from '@/agents/types'
import type { CompiledFilter } from './types'

/** Stable id of the All filter row; matched by `seed-filters.ts`. */
export const ALL_FILTER_ID = 'default-all'

/**
 * Returns true if the event should be visible in the timeline and event
 * stream — i.e., it passes the All filter's negated exclusion patterns.
 *
 * If the All filter is absent from the compiled set (deleted by the
 * user, or disabled — `compileFilters` skips disabled rows), every
 * event passes.
 */
export function passesAllFilter(
  raw: RawEvent,
  toolName: string | null,
  compiled: readonly CompiledFilter[],
): boolean {
  const all = compiled.find((f) => f.id === ALL_FILTER_ID)
  if (!all) return true

  let payloadText: string | null = null
  const getPayload = () => payloadText ?? (payloadText = JSON.stringify(raw))

  const wantAll = all.combinator === 'and'
  let matched = wantAll
  for (const p of all.patterns) {
    const target =
      p.target === 'hook'
        ? (raw.hookName ?? '')
        : p.target === 'tool'
          ? (toolName ?? '')
          : getPayload()
    const hit = p.negate ? !p.regex.test(target) : p.regex.test(target)
    if (wantAll && !hit) {
      matched = false
      break
    }
    if (!wantAll && hit) {
      matched = true
      break
    }
  }
  return matched
}
