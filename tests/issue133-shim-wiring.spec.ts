/**
 * The CONFIG WIRING of the #132/#133 switches, at the shim boundary.
 *
 * `src/upstream.ts` covers the pure transforms; this file pins what only
 * exists once the options travel through `createWorkBuddyShim` — that the
 * shim actually hands each switch to the prepared body, and that a body the
 * switches do not apply to arrives byte-identical. A regression here (an
 * option renamed, dropped on the floor, or applied unconditionally) would
 * pass every unit test in `upstream.spec.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult, WorkBuddyUpstreamClient } from '../src/upstream.ts'

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

function streamOf(): WorkBuddyChatResult {
  const encoder = new TextEncoder()
  const frame = `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  return { ok: true, response: new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame)); controller.close() },
  })) }
}

/** The title body exactly as the host sends it (template + one user message). */
function titleBody(): string {
  return JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'user', content: 'Generate the session title from this JSON array of human messages:\n'
        + JSON.stringify([{ seq: 0, text: '推荐几个菜谱' }]) },
    ],
  })
}

type ShimOptions = Parameters<typeof createWorkBuddyShim>[0]
type ExtraOptions = Pick<ShimOptions, 'keepPromptLast' | 'extraInjectedPrefixes' | 'sessionTitle'>

function makeShim(options: ExtraOptions = {}): {
  shim: WorkBuddyShim
  seenBodies: string[]
} {
  const seenBodies: string[] = []
  const created = createWorkBuddyShim({
    store,
    client: {
      chatStream: async (_credential: WorkBuddyCredential, body: string): Promise<WorkBuddyChatResult> => {
        seenBodies.push(body)
        return streamOf()
      },
    } as unknown as WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
    ...options,
  })
  return { shim: created, seenBodies }
}

async function post(target: WorkBuddyShim, body: string): Promise<void> {
  await target.ready
  const response = await fetch(`${target.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${target.token()}`, 'content-type': 'application/json' },
    body,
  })
  expect(response.status).toBe(200)
  await response.text()
}

describe('shim wiring of the #132/#133 switches', () => {
  it('re-points a title request when sessionTitle is enabled', async () => {
    const created = makeShim({ sessionTitle: { enabled: true } })
    shim = created.shim
    await post(shim, titleBody())
    expect(created.seenBodies).toHaveLength(1)
    expect(JSON.parse(created.seenBodies[0]!).model).toBe('wb-lite')
  })

  it('honours a configured sessionTitle.model through the shim', async () => {
    const created = makeShim({ sessionTitle: { enabled: true, model: 'wb-mini' } })
    shim = created.shim
    await post(shim, titleBody())
    expect(JSON.parse(created.seenBodies[0]!).model).toBe('wb-mini')
  })

  it('leaves the title on the main model when the switch is off (the default)', async () => {
    const created = makeShim()
    shim = created.shim
    await post(shim, titleBody())
    expect(JSON.parse(created.seenBodies[0]!).model).toBe('deepseek-v4.1-flash')
  })

  it('leaves an ordinary conversation on the main model even with the switch on', async () => {
    const created = makeShim({ sessionTitle: { enabled: true } })
    shim = created.shim
    await post(shim, JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '普通提问' }],
    }))
    expect(JSON.parse(created.seenBodies[0]!).model).toBe('deepseek-v4.1-flash')
  })

  it('plumbs keepPromptLast and extraInjectedPrefixes into the prepared body', async () => {
    const created = makeShim({
      keepPromptLast: true,
      extraInjectedPrefixes: ['SOME-NEW-PLUGIN-CONTEXT:'],
    })
    shim = created.shim
    await post(shim, JSON.stringify({
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'prompt' },
        { role: 'user', content: '真实输入' },
        { role: 'user', content: 'SOME-NEW-PLUGIN-CONTEXT:\n注入块' },
      ],
    }))
    const messages = JSON.parse(created.seenBodies[0]!).messages
    expect(String(messages.at(-1).content)).toBe('真实输入')
  })

  it('does not move a custom-prefix block that was not configured', async () => {
    const created = makeShim({ keepPromptLast: true })
    shim = created.shim
    await post(shim, JSON.stringify({
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'prompt' },
        { role: 'user', content: '真实输入' },
        { role: 'user', content: 'SOME-NEW-PLUGIN-CONTEXT:\n注入块' },
      ],
    }))
    const messages = JSON.parse(created.seenBodies[0]!).messages
    expect(String(messages.at(-1).content)).toBe('SOME-NEW-PLUGIN-CONTEXT:\n注入块')
  })
})
