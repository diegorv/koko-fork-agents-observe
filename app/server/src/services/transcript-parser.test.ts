import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTranscriptFile } from './transcript-parser'

// Hand-rolled jsonl exercising:
//   - assistant lines split across multiple content blocks of the same message.id
//   - tool_use ids unioned from two blocks
//   - parentUuid chain traversing an attachment line
//   - subagent (isSidechain=true) excluded from summary but in calls[]
//   - two distinct models
//   - one originating user prompt with promptId="p1"
const FIXTURE_LINES = [
  // Originating user prompt (string content)
  {
    type: 'user',
    uuid: 'u1',
    parentUuid: null,
    promptId: 'p1',
    sessionId: 's',
    timestamp: '2026-05-22T00:00:00.000Z',
    message: { content: 'hello world' },
  },
  // Attachment line in the parent chain (tests chain traversal)
  {
    type: 'attachment',
    uuid: 'a1',
    parentUuid: 'u1',
    sessionId: 's',
    timestamp: '2026-05-22T00:00:00.500Z',
  },
  // Assistant msg1, block 1 (thinking)
  {
    type: 'assistant',
    uuid: 'as1a',
    parentUuid: 'a1',
    sessionId: 's',
    timestamp: '2026-05-22T00:00:01.000Z',
    isSidechain: false,
    requestId: 'req_aaaa',
    message: {
      id: 'msg1',
      model: 'claude-opus-4-7',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 },
        service_tier: 'standard',
      },
      content: [{ type: 'thinking', thinking: '' }],
    },
  },
  // Assistant msg1, block 2 (tool_use) — same message.id, same usage object
  {
    type: 'assistant',
    uuid: 'as1b',
    parentUuid: 'as1a',
    sessionId: 's',
    timestamp: '2026-05-22T00:00:01.500Z',
    isSidechain: false,
    requestId: 'req_aaaa',
    message: {
      id: 'msg1',
      model: 'claude-opus-4-7',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 },
        service_tier: 'standard',
      },
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read' },
        { type: 'tool_use', id: 'toolu_2', name: 'Bash' },
      ],
    },
  },
  // Assistant msg1, block 3 (text) — third duplicate. Verifies that the
  // dedup happens at the message.id level AND that usage isn't summed
  // across blocks.
  {
    type: 'assistant',
    uuid: 'as1c',
    parentUuid: 'as1b',
    sessionId: 's',
    timestamp: '2026-05-22T00:00:01.700Z',
    isSidechain: false,
    requestId: 'req_aaaa',
    message: {
      id: 'msg1',
      model: 'claude-opus-4-7',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 },
        service_tier: 'standard',
      },
      content: [{ type: 'text', text: 'wrap-up' }],
    },
  },
  // Tool-result follow-up user line (propagates promptId)
  {
    type: 'user',
    uuid: 'u2',
    parentUuid: 'as1c',
    promptId: 'p1',
    sessionId: 's',
    timestamp: '2026-05-22T00:00:02.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
  },
  // Assistant msg2 — different model
  {
    type: 'assistant',
    uuid: 'as2',
    parentUuid: 'u2',
    sessionId: 's',
    timestamp: '2026-05-22T00:00:03.000Z',
    isSidechain: false,
    requestId: 'req_bbbb',
    message: {
      id: 'msg2',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 5,
        output_tokens: 200,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard',
      },
      content: [{ type: 'text', text: 'done' }],
    },
  },
  // Subagent assistant — must appear in calls[] but NOT in summary
  {
    type: 'assistant',
    uuid: 'as3',
    parentUuid: 'u2',
    sessionId: 's',
    timestamp: '2026-05-22T00:00:04.000Z',
    isSidechain: true,
    requestId: 'req_cccc',
    message: {
      id: 'msg3',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard',
      },
      content: [{ type: 'text', text: 'sub' }],
    },
  },
]

const TMP_DIR = mkdtempSync(join(tmpdir(), 'transcript-parser-'))
const FIXTURE_PATH = join(TMP_DIR, 'fixture.jsonl')

beforeAll(() => {
  writeFileSync(FIXTURE_PATH, FIXTURE_LINES.map((l) => JSON.stringify(l)).join('\n') + '\n')
})

afterAll(() => {
  try {
    unlinkSync(FIXTURE_PATH)
  } catch {}
})

describe('parseTranscriptFile — shape and dedup', () => {
  test('summary aggregates main-agent only across models — usage NOT summed across duplicate blocks of the same messageId', async () => {
    const stats = await parseTranscriptFile(FIXTURE_PATH)
    expect(stats.summary.totalCalls).toBe(2) // msg1 + msg2, NOT msg3 (sub), NOT msg1×3
    const byModel = [...stats.summary.byModel].sort((a, b) => a.model.localeCompare(b.model))
    expect(byModel).toEqual([
      {
        model: 'claude-opus-4-7',
        calls: 1,
        inputTokens: 10,
        outputTokens: 100,
        cacheReadTokens: 50,
        cacheCreate5mTokens: 0,
        cacheCreate1hTokens: 20,
      },
      {
        model: 'claude-sonnet-4-6',
        calls: 1,
        inputTokens: 5,
        outputTokens: 200,
        cacheReadTokens: 60,
        cacheCreate5mTokens: 0,
        cacheCreate1hTokens: 0,
      },
    ])
  })

  test('calls[] deduped by message.id with tool_use ids unioned across blocks', async () => {
    const stats = await parseTranscriptFile(FIXTURE_PATH)
    expect(stats.calls.length).toBe(3) // msg1, msg2, msg3 (subagent included here)
    const msg1 = stats.calls.find((c) => c.messageId === 'msg1')!
    expect(msg1.toolUseIds).toEqual(['toolu_1', 'toolu_2'])
    expect(msg1.model).toBe('claude-opus-4-7')
    expect(msg1.isSidechain).toBe(false)
    expect(msg1.requestId).toBe('req_aaaa')
    expect(msg1.serviceTier).toBe('standard')
    expect(msg1.stopReason).toBe('tool_use')
    expect(msg1.usage).toEqual({
      inputTokens: 10,
      outputTokens: 100,
      cacheReadTokens: 50,
      cacheCreate5mTokens: 0,
      cacheCreate1hTokens: 20,
    })
  })

  test('subagent call present in calls[] but excluded from summary', async () => {
    const stats = await parseTranscriptFile(FIXTURE_PATH)
    const sub = stats.calls.find((c) => c.messageId === 'msg3')!
    expect(sub.isSidechain).toBe(true)
    expect(stats.summary.byModel.some((m) => m.model === 'claude-haiku-4-5')).toBe(false)
  })
})

describe('parseTranscriptFile — promptId resolution', () => {
  test('walks parentUuid through attachment lines to find promptId', async () => {
    const stats = await parseTranscriptFile(FIXTURE_PATH)
    // msg1 chain: as1a -> a1 (attachment) -> u1 (user, promptId=p1)
    const msg1 = stats.calls.find((c) => c.messageId === 'msg1')!
    expect(msg1.promptId).toBe('p1')
  })

  test('resolves promptId via tool_result follow-up user line', async () => {
    const stats = await parseTranscriptFile(FIXTURE_PATH)
    // msg2 chain: as2 -> u2 (tool_result, promptId=p1)
    const msg2 = stats.calls.find((c) => c.messageId === 'msg2')!
    expect(msg2.promptId).toBe('p1')
  })

  test('prompts map contains originating prompt text, not tool_result content', async () => {
    const stats = await parseTranscriptFile(FIXTURE_PATH)
    expect(stats.prompts).toEqual({
      p1: { text: 'hello world', timestamp: Date.parse('2026-05-22T00:00:00.000Z') },
    })
    // Explicit anti-regression: no entry leaks from u2 (tool_result user
    // line that propagates promptId=p1 but isn't an originating prompt).
    expect(Object.keys(stats.prompts).length).toBe(1)
    expect(Object.values(stats.prompts).every((p) => p.text !== 'ok')).toBe(true)
  })
})
