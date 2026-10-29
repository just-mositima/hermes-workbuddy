/**
 * The standalone-gateway additions: a DECLARED port, a STATIC bearer, and the
 * non-streaming (`stream: false`) JSON answer.
 *
 * These three exist for consumers other than the original host — Hermes,
 * wired in as an OpenAI-compatible custom provider. Each test guards the one
 * property such a consumer depends on and the original host path must NOT
 * inherit:
 *
 *   - a declared port binds THAT port (its address lives in static config,
 *     so a silent re-roll would be an endpoint that never answers);
 *   - a declared token is answered verbatim (the consumer persisted it), and
 *     every other bearer is still refused — the loopback bind alone is not a
 *     trust boundary;
 *   - `stream: false` gets ONE chat.completion JSON body, while `stream:
 *     true` and an ABSENT `stream` keep the original SSE answer byte-for-byte
 *     (the default flip is deliberately not adopted; the original host has
 *     always received SSE).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'
import { aggregateChatCompletion } from '../src/openai-json.ts'

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}

const store = {
  resolve: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

function bearer(token: string): string {
  return ['Bearer', token].join(' ')
}

/** Upstream frames, exactly as the wire carries them. */
function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

const UPSTREAM_SSE = [
  frame({ id: 'chatcmpl-up', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: '' }] }),
  frame({ id: 'chatcmpl-up', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: '' }] }),
  frame({ id: 'chatcmpl-up', choices: [{ index: 0, delta: { content: '，世界' }, finish_reason: '' }] }),
  frame({ id: 'chatcmpl-up', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  'data: [DONE]\n\n',
].join('')

function makeShim(options: { port?: number, token?: string } = {}): WorkBuddyShim {
  const created = createWorkBuddyShim({
    store,
    client: {
      chatStream: async (): Promise<WorkBuddyChatResult> => ({
        ok: true,
        response: new Response(UPSTREAM_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      }),
    } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
    ...options.port === undefined ? {} : { port: options.port },
    ...options.token === undefined ? {} : { token: options.token },
  })
  shim = created
  return created
}

const BODY = JSON.stringify({
  model: 'deepseek-v4',
  messages: [{ role: 'user', content: 'hi' }],
})

describe('declared port and token (the standalone gateway contract)', () => {
  it('binds the declared port and answers the declared bearer, refusing others', async () => {
    const target = makeShim({ port: 18787, token: 'persisted-secret' })
    await target.ready
    expect(target.baseUrl()).toBe('http://127.0.0.1:18787')
    expect(target.token()).toBe('persisted-secret')

    const health = await fetch('http://127.0.0.1:18787/healthz', {
      headers: { authorization: 'Bearer persisted-secret' },
    })
    expect(health.status).toBe(200)

    const forged = await fetch('http://127.0.0.1:18787/v1/models', {
      headers: { authorization: bearer('wrong') },
    })
    expect(forged.status).toBe(401)

    const anonymous = await fetch('http://127.0.0.1:18787/v1/models')
    expect(anonymous.status).toBe(401)
  })

  it('fails ready when the declared port is taken, instead of re-rolling to another', async () => {
    const first = makeShim({ port: 18788, token: 'a' })
    await first.ready
    const second = createWorkBuddyShim({
      store,
      client: { chatStream: async () => ({ ok: false, status: 502, kind: 'server', message: 'unused' }) } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(),
      port: 18788,
      token: 'b',
    })
    await expect(second.ready).rejects.toThrow()
    await second.close()
  })
})

/** POST a body to the shim and return the raw response. */
async function post(target: WorkBuddyShim, body: string): Promise<Response> {
  return await fetch(`${target.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: bearer(target.token()), 'content-type': 'application/json' },
    body,
  })
}

describe('non-streaming requests get one JSON completion', () => {
  it('aggregates the stream into a chat.completion body with usage', async () => {
    const target = makeShim({ token: 's' })
    await target.ready
    const response = await post(target, BODY.replace('"messages"', '"stream":false,"messages"'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json() as Record<string, any>
    expect(body['object']).toBe('chat.completion')
    expect(body['model']).toBe('deepseek-v4')
    const choice = (body['choices'] as Record<string, any>[])[0] as Record<string, any>
    expect(choice['message']['role']).toBe('assistant')
    expect(choice['message']['content']).toBe('你好，世界')
    expect(choice['finish_reason']).toBe('stop')
    expect(body['usage']).toEqual({ prompt_tokens: 5, completion_tokens: 2 })
  })

  it('keeps stream:true on SSE — the original host path is untouched', async () => {
    const target = makeShim({ token: 's' })
    await target.ready
    const response = await post(target, BODY.replace('"messages"', '"stream":true,"messages"'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toContain('data: [DONE]')
  })

  it('answers an ABSENT stream with JSON — the OpenAI default, and what aux callers send', async () => {
    // Measured failure this pins: Hermes' auxiliary vision call omits `stream`,
    // got SSE back, and died with "invalid response ... chat.completion.chunk".
    // Only an explicit `stream: true` may hold the SSE answer.
    const target = makeShim({ token: 's' })
    await target.ready
    const response = await post(target, BODY)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json() as Record<string, any>
    expect(body['object']).toBe('chat.completion')
    expect((body['choices'] as Record<string, any>[])[0]?.['message']?.['content']).toBe('你好，世界')
  })
})

describe('aggregateChatCompletion (the fold itself)', () => {
  it('merges tool-call fragments by index and synthesizes no duplicates', () => {
    const sse = [
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: undefined } }] }),
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } }] } }] }),
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a"}' } }] } }] }),
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'write', arguments: '{}' } }] } }] }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ].join('')
    const { body, hadFrames, sawDone } = aggregateChatCompletion(sse, { modelId: 'm1' })
    expect(hadFrames).toBe(true)
    expect(sawDone).toBe(true)
    const choice = (body['choices'] as Record<string, any>[])[0] as Record<string, any>
    expect(choice['finish_reason']).toBe('tool_calls')
    const calls = choice['message']['tool_calls'] as Record<string, any>[]
    expect(calls).toHaveLength(2)
    expect(calls[0]?.['function']).toEqual({ name: 'read', arguments: '{"path":"/a"}' })
    expect(calls[1]?.['id']).toBe('call_2')
  })

  it('skips unparseable frames rather than failing a paid answer', () => {
    const sse = [
      'data: {not json\n\n',
      frame({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ].join('')
    const { body, hadFrames } = aggregateChatCompletion(sse)
    expect(hadFrames).toBe(true)
    const choice = (body['choices'] as Record<string, any>[])[0] as Record<string, any>
    expect(choice['message']['content']).toBe('ok')
  })

  it('reports no frames for an empty stream', () => {
    const { hadFrames, sawDone } = aggregateChatCompletion('')
    expect(hadFrames).toBe(false)
    expect(sawDone).toBe(false)
  })
})
