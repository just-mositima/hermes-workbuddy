/**
 * SSE-to-JSON aggregation for OpenAI-compatible clients that ask for a
 * NON-STREAMING answer (`"stream": false`).
 *
 * The WorkBuddy upstream only speaks streaming, and the shim's whole rescue
 * ladder (DSML recovery, the markup-only retry, pool failover) is built on
 * inspecting the SSE frames as they pass. So a non-streaming request is not
 * answered by a second upstream path — the stream runs exactly as it always
 * has, its frames are COLLECTED instead of forwarded, and the finished
 * answer is folded into one `chat.completion` object at the end.
 *
 * Why this exists at all: consumers other than the original host (notably
 * Hermes, wired in as an OpenAI-compatible provider) issue ordinary
 * non-streaming calls for auxiliary work — conversation titles, compression
 * summaries, small classification probes. An endpoint that answers those with
 * `text/event-stream` breaks the client's JSON parse; every one of those
 * calls would fail while interactive chat (streaming) worked fine, which is
 * the worst failure shape to debug.
 *
 * The aggregation rules mirror what every OpenAI client does with a stream:
 * deltas concatenate, the first role wins, tool-call fragments merge by
 * `index` (id/name from the first fragment that carries them, arguments
 * concatenated), the last non-empty `finish_reason` wins, and `usage` is the
 * last frame that carried one. Deliberately tolerant: a frame that does not
 * parse is skipped rather than failing the whole answer, because by the time
 * aggregation runs the upstream has already been paid for the tokens.
 *
 * @module workbuddy/openai-json
 */

/** What one aggregated answer turned out to be. */
export interface AggregatedChatCompletion {
  /** The `chat.completion` document to answer a non-streaming request with. */
  body: Record<string, unknown>
  /** Whether the stream carried at least one parseable `data:` frame. */
  hadFrames: boolean
  /** Whether the stream reached `data: [DONE]`. */
  sawDone: boolean
}

interface ToolCallAccumulator {
  id?: string
  type?: string
  function: { name?: string, arguments: string }
}

/** Parse the SSE text the shim emitted and fold it into one completion. */
export function aggregateChatCompletion(
  sse: string,
  options: { modelId?: string, id?: string, createdMs?: number } = {},
): AggregatedChatCompletion {
  let role = 'assistant'
  let content = ''
  let refusal: string | undefined
  const toolCalls = new Map<number, ToolCallAccumulator>()
  let finishReason: string | undefined
  let usage: Record<string, unknown> | undefined
  let hadFrames = false
  let sawDone = false

  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice('data:'.length).trim()
    if (data === '') continue
    if (data === '[DONE]') {
      sawDone = true
      continue
    }
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      continue
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) continue
    hadFrames = true
    const record = frame as Record<string, unknown>
    if (typeof record['id'] === 'string' && options.id === undefined) options = { ...options, id: record['id'] }
    if (typeof record['created'] === 'number' && options.createdMs === undefined) {
      options = { ...options, createdMs: record['created'] }
    }
    if (typeof record['model'] === 'string' && options.modelId === undefined) {
      options = { ...options, modelId: record['model'] }
    }
    if (record['usage'] !== null && typeof record['usage'] === 'object' && !Array.isArray(record['usage'])) {
      usage = record['usage'] as Record<string, unknown>
    }
    const choices = record['choices']
    if (!Array.isArray(choices)) continue
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) continue
      const choiceRecord = choice as Record<string, unknown>
      if (typeof choiceRecord['finish_reason'] === 'string' && choiceRecord['finish_reason'] !== '') {
        finishReason = choiceRecord['finish_reason']
      }
      const delta = choiceRecord['delta'] ?? choiceRecord['message']
      if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) continue
      const deltaRecord = delta as Record<string, unknown>
      if (typeof deltaRecord['role'] === 'string' && deltaRecord['role'] !== '') role = deltaRecord['role']
      if (typeof deltaRecord['content'] === 'string') content += deltaRecord['content']
      if (typeof deltaRecord['refusal'] === 'string' && deltaRecord['refusal'] !== '') refusal = deltaRecord['refusal']
      const calls = deltaRecord['tool_calls']
      if (!Array.isArray(calls)) continue
      for (const call of calls) {
        if (typeof call !== 'object' || call === null || Array.isArray(call)) continue
        const callRecord = call as Record<string, unknown>
        const index = typeof callRecord['index'] === 'number' ? (callRecord['index'] as number) : 0
        const accumulator = toolCalls.get(index) ?? { function: { arguments: '' } }
        if (typeof callRecord['id'] === 'string' && callRecord['id'] !== '') accumulator.id = callRecord['id']
        if (typeof callRecord['type'] === 'string' && callRecord['type'] !== '') accumulator.type = callRecord['type']
        const fn = callRecord['function']
        if (typeof fn === 'object' && fn !== null && !Array.isArray(fn)) {
          const fnRecord = fn as Record<string, unknown>
          if (typeof fnRecord['name'] === 'string' && fnRecord['name'] !== '') accumulator.function.name = fnRecord['name']
          if (typeof fnRecord['arguments'] === 'string') accumulator.function.arguments += fnRecord['arguments']
        }
        toolCalls.set(index, accumulator)
      }
    }
  }

  const message: Record<string, unknown> = { role }
  if (content !== '') message['content'] = content
  if (refusal !== undefined) message['refusal'] = refusal
  if (toolCalls.size > 0) {
    message['tool_calls'] = [...toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, call], position) => ({
        index,
        id: call.id ?? `call_${position}`,
        type: call.type ?? 'function',
        function: { name: call.function.name ?? '', arguments: call.function.arguments },
      }))
    if (finishReason === undefined) finishReason = 'tool_calls'
    if (message['content'] === undefined) message['content'] = null
  }
  if (message['content'] === undefined && message['refusal'] === undefined && toolCalls.size === 0) {
    message['content'] = ''
  }

  const body: Record<string, unknown> = {
    id: options.id ?? 'chatcmpl-workbuddy',
    object: 'chat.completion',
    created: options.createdMs ?? Math.floor(Date.now() / 1000),
    model: options.modelId ?? 'workbuddy',
    choices: [{
      index: 0,
      message,
      ...finishReason === undefined ? {} : { finish_reason: finishReason },
    }],
    ...usage === undefined ? {} : { usage },
  }
  return { body, hadFrames, sawDone }
}
