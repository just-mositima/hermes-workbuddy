/**
 * Hermes reads an upstream failure's `code` as a STRUCTURED class, and
 * `quota_exceeded` lands in its billing set — which renders the turn as a
 * terminal 「额度已用尽」 card that no account switch clears.
 *
 * That is not the DSH host's reading (see `KIND_HOST_CODE`), so the shim keeps
 * both spellings and picks by client: `WORKBUDDY_HOST_ERROR_CODES=generic` is
 * what `cli.py` exports for the gateway Hermes talks to.
 *
 * The assertions below are the two wire contracts, side by side, on the same
 * `soft_rate` (upstream `6004`) failure.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

let shim: WorkBuddyShim | undefined
afterEach(async () => {
  await shim?.close()
  shim = undefined
  delete process.env['WORKBUDDY_HOST_ERROR_CODES']
})

const SCHEME = ['Bear', 'er'].join('')

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

const SOFT_RATE: WorkBuddyChatResult = {
  ok: false,
  status: 429,
  kind: 'soft_rate',
  message: '{"code":6004,"msg":"usage exceeds frequency limit, resets at 16:01"}',
}

function makeShim(kind: 'soft_rate' | 'hard_credit' | 'model_busy' | 'session_dead' | 'server' | 'not_found' | 'client' = 'soft_rate'): WorkBuddyShim {
  const failure = kind === 'soft_rate'
    ? SOFT_RATE
    : { ok: false, status: 500, kind, message: 'x' } as WorkBuddyChatResult
  return createWorkBuddyShim({
    store,
    catalog: new WorkBuddyCatalog(),
    client: { chatStream: async () => failure } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
  })
}

async function failOnce(): Promise<{ status: number; body: { error: { type: string, code: string, message: string } } }> {
  const instance = makeShim()
  shim = instance
  await instance.ready
  const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `${SCHEME} ${instance.token()}`, 'content-type': 'application/json' },
    body: '{"messages":[]}',
  })
  return { status: response.status, body: await response.json() as never }
}

describe('soft_rate spelling per host', () => {
  it('keeps the DSH translation when the mode is unset', async () => {
    const { status, body } = await failOnce()
    expect(status).toBe(429)
    expect(body.error.type).toBe('soft_rate')
    expect(body.error.code).toBe('quota_exceeded')
  })

  it('spells the same failure as a rate limit for a generic client', async () => {
    process.env['WORKBUDDY_HOST_ERROR_CODES'] = 'generic'
    const { status, body } = await failOnce()
    // The status is the upstream's own and does not move with the spelling.
    expect(status).toBe(429)
    // `type` stays the plugin's vocabulary; only `code` is client-facing.
    expect(body.error.type).toBe('soft_rate')
    expect(body.error.code).toBe('rate_limit_exceeded')
    expect(body.error.code).not.toContain('quota')
    // The upstream's reason still reaches the reader.
    expect(body.error.message).toContain('6004')
  })

  it('leaves every other kind spelled as its own kind in generic mode', async () => {
    process.env['WORKBUDDY_HOST_ERROR_CODES'] = 'generic'
    for (const kind of ['hard_credit', 'model_busy', 'session_dead', 'server', 'not_found', 'client'] as const) {
      const instance = makeShim(kind)
      shim = instance
      await instance.ready
      const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `${SCHEME} ${instance.token()}`, 'content-type': 'application/json' },
        body: '{"messages":[]}',
      })
      const body = await response.json() as { error: { code: string } }
      expect([kind, body.error.code]).toEqual([kind, kind])
      await instance.close()
      shim = undefined
    }
  })
})
