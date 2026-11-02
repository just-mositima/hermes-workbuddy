/**
 * `/v1/models` must not stay empty once an account exists.
 *
 * Measured failure this guards (2026-11-02, fresh Hermes install): the sign-in
 * gate that empties a signed-out region is evaluated at startup and on the
 * periodic refresh only — 30 minutes by default. A user who installed the
 * plugin, then signed in on the already-running gateway, saw every test pass and
 * "WorkBuddy CN — 0 models" in the switch-model screen, because the picker
 * discovers models by probing exactly this route.
 *
 * So an EMPTY answer re-reads the roster on demand. The three properties that
 * matter:
 *
 *   - empty catalog + an owner that can refresh => the probe returns the models
 *     the refresh installed (the fix);
 *   - non-empty catalog => no extra work (no upstream call per picker open);
 *   - a slow/hung refresh never holds the probe past a picker's budget.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

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

const store = { resolve: async () => CREDENTIAL } as unknown as WorkBuddyCredentialStore
const SHIM_TOKEN = 'shim-token'

function bearer(token: string): string {
  return ['Bearer', token].join(' ')
}

async function makeShim(
  onModelsEmpty: () => Promise<void> | void,
  options: { usable?: boolean } = {},
): Promise<WorkBuddyCatalog> {
  const catalog = new WorkBuddyCatalog('cn')
  // `usable: false` is the signed-out gate: same catalog, empty answer.
  catalog.setRegionUsable(options.usable ?? false)
  const created = createWorkBuddyShim({
    store,
    client: {
      chatStream: async () => ({ ok: false, status: 500, kind: 'upstream' }),
    } as unknown as WorkBuddyUpstreamClient,
    catalog,
    token: SHIM_TOKEN,
    onModelsEmpty,
  })
  shim = created
  await created.ready
  return catalog
}

async function listModels(): Promise<string[]> {
  if (shim === undefined) throw new Error('no shim')
  const response = await fetch(`${shim.baseUrl()}/v1/models`, {
    headers: { authorization: bearer(SHIM_TOKEN) },
  })
  const body = await response.json() as { data: Array<{ id: string }> }
  return body.data.map(entry => entry.id)
}

describe('/v1/models on-demand catalog self-heal', () => {
  it('re-reads the roster when the catalog is empty, so a late sign-in shows up on the first probe', async () => {
    let refreshes = 0
    const catalog = await makeShim(() => {
      refreshes += 1
      // What gateway.refreshCatalog() does once the account is there.
      catalog.set([{ id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 }])
      catalog.setRegionUsable(true)
    })

    expect(await listModels()).toEqual(['hy3'])
    expect(refreshes).toBe(1)
  })

  it('leaves a non-empty catalog alone — no upstream work per picker open', async () => {
    let refreshes = 0
    await makeShim(() => { refreshes += 1 }, { usable: true })

    const ids = await listModels()
    expect(ids.length).toBeGreaterThan(0)
    expect(refreshes).toBe(0)
  })

  it('answers inside a picker budget even when the refresh hangs', async () => {
    await makeShim(() => new Promise<void>(() => {}))

    const startedMs = Date.now()
    const ids = await listModels()
    const elapsedMs = Date.now() - startedMs

    expect(ids).toEqual([])
    expect(elapsedMs).toBeLessThan(3_000)
  })
})
