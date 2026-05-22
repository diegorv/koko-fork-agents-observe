import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

// ── Types ─────────────────────────────────────────────────────────

export interface TranscriptUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreate5mTokens: number
  cacheCreate1hTokens: number
}

export interface TranscriptCall {
  messageId: string
  requestId: string | null
  timestamp: number
  model: string
  isSidechain: boolean
  serviceTier: string | null
  stopReason: string | null
  usage: TranscriptUsage
  toolUseIds: string[]
  promptId: string | null
}

export interface TranscriptByModel extends TranscriptUsage {
  model: string
  calls: number
}

export interface TranscriptSummary {
  totalCalls: number
  byModel: TranscriptByModel[]
}

export interface TranscriptStats {
  source: 'jsonl'
  summary: TranscriptSummary
  calls: TranscriptCall[]
  prompts: Record<string, { text: string; timestamp: number }>
}

// ── Parsing primitives ────────────────────────────────────────────

interface IndexedLine {
  uuid: string | null
  parentUuid: string | null
  type: string
  promptId: string | null
  timestamp: number
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : 0
}

function extractUsage(u: any): TranscriptUsage {
  const cache = u?.cache_creation ?? {}
  return {
    inputTokens: Number(u?.input_tokens ?? 0),
    outputTokens: Number(u?.output_tokens ?? 0),
    cacheReadTokens: Number(u?.cache_read_input_tokens ?? 0),
    cacheCreate5mTokens: Number(cache?.ephemeral_5m_input_tokens ?? 0),
    cacheCreate1hTokens: Number(cache?.ephemeral_1h_input_tokens ?? 0),
  }
}

// ── Public entrypoint ─────────────────────────────────────────────

export async function parseTranscriptFile(filePath: string): Promise<TranscriptStats> {
  // Single streaming pass. Builds:
  //   - callMap (dedup assistant lines by message.id)
  //   - lineIndex (every line type — for parentUuid walks)
  //   - prompts (originating-prompt user lines, keyed by promptId)
  //   - firstUuidByMessageId (parallel map for the parent-walk start)
  const callMap = new Map<string, TranscriptCall>()
  const lineIndex = new Map<string, IndexedLine>()
  const prompts: Record<string, { text: string; timestamp: number }> = {}
  // Parallel map: messageId → uuid of the first jsonl line that
  // introduced this call. Used as the starting point for the
  // parentUuid walk below. Kept separate from `callMap` so the public
  // TranscriptCall type stays clean.
  const firstUuidByMessageId = new Map<string, string>()

  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const raw of rl) {
    if (!raw) continue
    let line: any
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    const uuid = typeof line.uuid === 'string' ? line.uuid : null
    const ts = parseTimestamp(line.timestamp)
    const indexed: IndexedLine = {
      uuid,
      parentUuid: typeof line.parentUuid === 'string' ? line.parentUuid : null,
      type: typeof line.type === 'string' ? line.type : '',
      promptId: typeof line.promptId === 'string' ? line.promptId : null,
      timestamp: ts,
    }
    if (uuid) lineIndex.set(uuid, indexed)

    if (line.type === 'assistant' && line.message && typeof line.message.id === 'string') {
      const msg = line.message
      const existing = callMap.get(msg.id)
      const toolUseIds: string[] = []
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use' && typeof block.id === 'string') {
            toolUseIds.push(block.id)
          }
        }
      }
      if (existing) {
        // Union tool_use ids across content blocks of the same message
        for (const id of toolUseIds) {
          if (!existing.toolUseIds.includes(id)) existing.toolUseIds.push(id)
        }
      } else {
        if (uuid) firstUuidByMessageId.set(msg.id, uuid)
        callMap.set(msg.id, {
          messageId: msg.id,
          requestId: typeof line.requestId === 'string' ? line.requestId : null,
          timestamp: ts, // first occurrence's timestamp
          model: typeof msg.model === 'string' ? msg.model : '',
          isSidechain: line.isSidechain === true,
          serviceTier:
            typeof msg.usage?.service_tier === 'string' ? msg.usage.service_tier : null,
          stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null,
          usage: extractUsage(msg.usage),
          toolUseIds,
          promptId: null, // resolved in the walk below
        })
      }
    } else if (line.type === 'user' && line.promptId && line.message) {
      // Originating prompt: content is a string OR content[0].type === 'text'.
      // Tool-result follow-ups have content as an array with first block type=tool_result.
      const content = line.message.content
      let text: string | null = null
      if (typeof content === 'string') {
        text = content
      } else if (
        Array.isArray(content) &&
        content[0]?.type === 'text' &&
        typeof content[0].text === 'string'
      ) {
        text = content[0].text
      }
      if (text !== null && !(line.promptId in prompts)) {
        prompts[line.promptId] = { text, timestamp: ts }
      }
    }
  }

  // Resolve promptId for each call by walking parentUuid back through
  // the line index until we hit any line carrying a non-null promptId.
  // Walk traverses every line type (attachments, system lines, etc.)
  // since they appear in real parent chains. Bounded by line count to
  // defend against pathological cycles.
  const maxWalkSteps = lineIndex.size + 1
  for (const [messageId, call] of callMap) {
    const startUuid = firstUuidByMessageId.get(messageId)
    if (!startUuid) continue
    let cursor: string | null = startUuid
    let steps = 0
    while (cursor && steps < maxWalkSteps) {
      const node = lineIndex.get(cursor)
      if (!node) break
      if (node.promptId) {
        call.promptId = node.promptId
        break
      }
      cursor = node.parentUuid
      steps += 1
    }
  }

  // Summary: main-agent only.
  const byModelMap = new Map<string, TranscriptByModel>()
  for (const c of callMap.values()) {
    if (c.isSidechain) continue
    const cur = byModelMap.get(c.model) ?? {
      model: c.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreate5mTokens: 0,
      cacheCreate1hTokens: 0,
    }
    cur.calls += 1
    cur.inputTokens += c.usage.inputTokens
    cur.outputTokens += c.usage.outputTokens
    cur.cacheReadTokens += c.usage.cacheReadTokens
    cur.cacheCreate5mTokens += c.usage.cacheCreate5mTokens
    cur.cacheCreate1hTokens += c.usage.cacheCreate1hTokens
    byModelMap.set(c.model, cur)
  }
  const summary: TranscriptSummary = {
    totalCalls: [...callMap.values()].filter((c) => !c.isSidechain).length,
    byModel: [...byModelMap.values()],
  }

  return {
    source: 'jsonl',
    summary,
    calls: [...callMap.values()],
    prompts,
  }
}
