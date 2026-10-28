/**
 * Standalone OpenAI-compatible gateway for WorkBuddy models — the Hermes
 * (and any OpenAI client) entry point of this package.
 *
 * What this is. The original plugin is a DeepSeek Harness (DSH) plugin: it
 * borrows the host's settings cards, model picker and adapter plumbing, and
 * its loopback shim exists to be pointed at by an in-process provider. This
 * module takes the SAME host-independent core — the credential store
 * (`auth.ts`), the upstream client (`upstream.ts`), the catalog, the
 * account-pool ranking, and the shim itself — and runs it as a long-lived
 * local server whose address and bearer token are STABLE across restarts,
 * because they have to live in a consumer's static config:
 *
 *   Hermes `config.yaml`:
 *     model:
 *       provider: custom
 *       base_url: http://127.0.0.1:8787/v1
 *       api_key: <token from the state dir>
 *
 * Nothing upstream-facing changed. The shim still applies every wire quirk
 * (forced streaming upstream, string `tool_choice`, CLI-shaped headers), the
 * whole rescue ladder still runs (channel-gate neutral head, invisible
 * perturbation, DSML markup recovery, markup-only retry), pool failover still
 * ranks accounts and benches the failed one with the upstream's own reset
 * time, and credentials are still the desktop app's sign-in, refreshed on
 * demand with a 5-minute margin. What changed is who is on the OTHER side of
 * the loopback port, and that the port and secret no longer die with the
 * host process.
 *
 * Region model: one gateway process serves BOTH regions, each on its own
 * port, each with its own store / catalog / shim / probe file — the same
 * parallel-stack rule the DSH plugin enforces, because the two gateways bill
 * different accounts and must never share state. A region with no local
 * sign-in serves an EMPTY `/v1/models` (never the static fallback): a picker
 * entry that can only 401 is worse than an absent one.
 *
 * State lives under one directory (`resolveStateDir`), defaulting to
 * `$HERMES_HOME/workbuddy` — its own credential copies, vault, pool probes
 * and selection files all derive from `$DSH_HOME`, which `serve` points at
 * that directory. A `--state-dir` (or `WORKBUDDY_STATE_DIR`) moves the whole
 * set together.
 *
 * @module workbuddy/gateway
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyCredentialStore } from './auth.ts'
import { WorkBuddyCatalog, deriveCatalog } from './catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
import { WorkBuddyUpstreamClient, type WorkBuddyRegion } from './upstream.ts'
import { rankPool, type WorkBuddyPoolExclusion, type WorkBuddyPoolMember, type WorkBuddyPoolProbe } from './account-pool.ts'
import { readPoolProbes, writePoolProbes } from './account-pool-store.ts'
import { cooldownOf, outcomeOfFailure, redactUpstreamText } from './probe.ts'
import { writeFileAtomic } from './host-peers.ts'

/** Both regions, in serving order. */
export const GATEWAY_REGIONS: readonly WorkBuddyRegion[] = ['cn', 'global']

/** Default loopback port per region; the second region steps aside by one. */
export const GATEWAY_DEFAULT_PORTS: Readonly<Record<WorkBuddyRegion, number>> = {
  cn: 8787,
  global: 8788,
}

/** How often the live catalog is refreshed from the upstream, by default. */
export const GATEWAY_DEFAULT_REFRESH_MS = 30 * 60_000

/**
 * Where the gateway keeps everything it owns.
 *
 * Precedence: an explicit `--state-dir`, then `$WORKBUDDY_STATE_DIR`, then an
 * already-set `$DSH_HOME` (a wrapper or a test that pinned it — never
 * silently repointed), then `$HERMES_HOME/workbuddy`, then
 * `~/.hermes/workbuddy`. The Hermes default is the point of this fork: the
 * gateway is a Hermes-side companion, so its state belongs beside Hermes'
 * own, not in the original plugin's `~/.dsh`.
 */
export function resolveStateDir(): string {
  const explicit = nonBlank(process.env['WORKBUDDY_STATE_DIR'])
  if (explicit !== undefined) return explicit
  const dshHome = nonBlank(process.env['DSH_HOME'])
  if (dshHome !== undefined) return dshHome
  const hermesHome = nonBlank(process.env['HERMES_HOME']) ?? join(homedir(), '.hermes')
  return join(hermesHome, 'workbuddy')
}

/**
 * Point every plugin-owned path (`$DSH_HOME` consumers: credential copies,
 * vault, pool probes, roster history) at one directory. Called once at the
 * top of every CLI entry so `serve` and the read-only commands can never
 * disagree about where state lives. An ALREADY-set `$DSH_HOME` wins — a test
 * or a wrapper that pinned it is obeyed, not overwritten.
 */
export function useWorkbuddyStateDir(stateDir: string): void {
  if (nonBlank(process.env['DSH_HOME']) === undefined) process.env['DSH_HOME'] = stateDir
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

/** Minimal console logger in the shim's shape. */
const logger = {
  warn: (...args: unknown[]): void => { process.stderr.write(`workbuddy gateway: ${fmt(args)}\n`) },
  error: (...args: unknown[]): void => { process.stderr.write(`workbuddy gateway: ${fmt(args)}\n`) },
}

function fmt(args: readonly unknown[]): string {
  return args.map(arg => arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)).join(' ')
}

/** The state file `serve` publishes for readers (and for `status`). */
export interface GatewayStateDocument {
  version: 1
  pid: number
  startedAt: string
  stateDir: string
  /** Relative to the state dir, so a moved directory keeps working. */
  tokenFile: string
  regions: Partial<Record<WorkBuddyRegion, {
    baseUrl: string
    port: number
    /** What the live catalog currently serves (empty while signed out). */
    modelIds: readonly string[]
  }>>
}

/** Flags `serve` accepts. */
export interface ServeOptions {
  regions: readonly WorkBuddyRegion[]
  ports: Readonly<Record<WorkBuddyRegion, number>>
  /** Explicit bearer; otherwise read or minted in the state dir. */
  token?: string
  stateDir: string
  /** Whether the pool rotates/fails-over across ALL local accounts. */
  pool: boolean
  refreshMs: number
  channelPerturbation: 'off' | 'failure' | 'always'
  keepPromptLast: boolean
}

interface RegionStack {
  region: WorkBuddyRegion
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  shim: WorkBuddyShim
  /** Last live roster, for the state file. Empty until the first refresh. */
  modelIds: string[]
}

function selectionFilePath(stateDir: string, region: WorkBuddyRegion): string {
  return join(stateDir, `selection.${region}.json`)
}

function modelsFilePath(stateDir: string, region: WorkBuddyRegion): string {
  return join(stateDir, `models.${region}.json`)
}

/** The user's persisted account choice for one region, if any. */
export async function readSelection(stateDir: string, region: WorkBuddyRegion): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(selectionFilePath(stateDir, region), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const accountId = (parsed as Record<string, unknown>)['accountId']
    return typeof accountId === 'string' && accountId !== '' ? accountId : undefined
  } catch {
    return undefined
  }
}

/** Persist (or clear, with `undefined`) the user's account choice. */
export async function writeSelection(
  stateDir: string,
  region: WorkBuddyRegion,
  accountId: string | undefined,
): Promise<void> {
  const path = selectionFilePath(stateDir, region)
  if (accountId === undefined) {
    await rm(path, { force: true })
    return
  }
  await writeFileAtomic(path, `${JSON.stringify({ accountId }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** The user's model enable-list for one region; empty set = all models. */
export async function readEnabledModels(
  stateDir: string,
  region: WorkBuddyRegion,
): Promise<ReadonlySet<string>> {
  try {
    const parsed = JSON.parse(await readFile(modelsFilePath(stateDir, region), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return new Set()
    const enabled = (parsed as Record<string, unknown>)['enabled']
    if (!Array.isArray(enabled)) return new Set()
    return new Set(enabled.filter((id): id is string => typeof id === 'string' && id !== ''))
  } catch {
    return new Set()
  }
}

/** Persist a model enable-list for one region (empty = serve everything). */
export async function writeEnabledModels(
  stateDir: string,
  region: WorkBuddyRegion,
  enabled: readonly string[],
): Promise<void> {
  const path = modelsFilePath(stateDir, region)
  if (enabled.length === 0) {
    await rm(path, { force: true })
    return
  }
  await writeFileAtomic(path, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** Read-or-mint the gateway bearer. A generated token is 0600 in the state dir. */
async function resolveGatewayToken(stateDir: string, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) return explicit
  const fromEnv = nonBlank(process.env['WORKBUDDY_GATEWAY_TOKEN'])
  if (fromEnv !== undefined) return fromEnv
  const path = join(stateDir, 'gateway-token')
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // Mint below.
  }
  const minted = randomBytes(32).toString('base64url')
  await writeFile(path, `${minted}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return minted
}

/**
 * One region's pool members: every account the store can see, each with its
 * last stored measurement.
 *
 * The DSH plugin gated membership on an explicit tick per account; a
 * standalone gateway has no card to tick on, so membership IS discovery —
 * every local sign-in is a candidate to bill, and `--no-pool` is the single
 * switch that reverts to one-account-at-a-time behaviour.
 */
async function poolMembers(
  stack: Pick<RegionStack, 'region' | 'store'>,
): Promise<readonly WorkBuddyPoolMember[]> {
  const [accounts, probesRecord] = await Promise.all([
    stack.store.accounts().catch(() => []),
    readPoolProbes(stack.region).catch((): Record<string, WorkBuddyPoolProbe> => ({})),
  ])
  const probes: Record<string, WorkBuddyPoolProbe> = probesRecord
  return accounts.map(account => ({
    account: {
      id: account.id,
      accountName: account.accountName,
      ...account.enterprise === undefined ? {} : { enterprise: account.enterprise },
    },
    ...probes[account.id] === undefined ? {} : { probe: probes[account.id] },
    tokenExpiresAtMs: account.tokenExpiresAtMs,
  }))
}

/** The one-line reason an exclusion excludes, for the failure reply. */
const EXCLUSION_TEXT: Readonly<Record<WorkBuddyPoolExclusion, string>> = {
  'unusable': '账号当前不可用',
  'rate-limited': '账号在限流冷却中',
  'model-busy': '模型负载冷却中',
  'out-of-credit': '账号积分已用尽',
  'credential-rejected': '凭据已被拒绝，需重新登录',
  'account-restricted': '账号被上游限制使用',
  'not-found': '账号不存在',
  'unavailable': '账号暂不可用',
  'failed': '账号上次请求失败，冷却中',
}

/** Persist what a failed live request taught us about one account. */
async function recordAccountFailure(
  stack: Pick<RegionStack, 'region'>,
  accountId: string,
  failure: { status: number, message: string, modelId?: string },
): Promise<void> {
  const outcome = outcomeOfFailure(failure.status, failure.message)
  if (outcome === 'ok') return
  const { retryAtMs } = cooldownOf({ outcome, retryAfter: null, nowMs: Date.now(), body: failure.message })
  const message = failure.message === '' ? '' : redactUpstreamText(failure.message)
  await writePoolProbes(stack.region, {
    [accountId]: {
      outcome,
      atMs: Date.now(),
      source: 'live-request',
      ...failure.modelId === undefined ? {} : { modelId: failure.modelId },
      ...retryAtMs === undefined ? {} : { retryAtMs },
      ...message === '' ? {} : { message },
    },
  })
}

/**
 * Run `serve`: bind every requested region, refresh catalogs, publish the
 * state file, and stay up until a signal arrives.
 *
 * Resolves only on shutdown; every startup failure rejects (a port in use is
 * the expected one), because a gateway that silently serves nothing is worse
 * than one that refuses to start.
 */
export async function runGateway(options: ServeOptions): Promise<void> {
  const { stateDir } = options
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  useWorkbuddyStateDir(stateDir)

  const client = new WorkBuddyUpstreamClient()
  const token = await resolveGatewayToken(stateDir, options.token)
  const stacks = new Map<WorkBuddyRegion, RegionStack>()

  for (const region of options.regions) {
    const store = new WorkBuddyCredentialStore({
      region,
      refresh: credential => client.refreshToken(credential),
    })
    // The saved selection, applied before anything resolves. Refresh stays the
    // store's own job; this only decides WHO serves.
    const selected = await readSelection(stateDir, region)
    if (selected !== undefined) store.selectAccount(selected)
    const catalog = new WorkBuddyCatalog(region)
    const shim = createWorkBuddyShim({
      store,
      client,
      catalog,
      logger,
      port: options.ports[region],
      token,
      channelPerturbation: options.channelPerturbation,
      keepPromptLast: options.keepPromptLast,
      ...(options.pool ? {
        // The ranking decides who serves BEFORE the request resolves, and who
        // to TRY after one fails — the same policy the DSH plugin runs, minus
        // its card: rank, drop the excluded, take the head.
        prepareAccount: async (): Promise<void> => {
          const selection = await readSelection(stateDir, region).catch(() => undefined)
          store.selectAccount(selection)
          if (!options.pool) return
          const winner = rankPool(await poolMembers({ region, store }), Date.now())
            .find(row => row.excludedBy === undefined)
          store.setRotatedAccount(winner?.account.id)
        },
        failoverAccount: async (triedAccountIds): Promise<Awaited<ReturnType<WorkBuddyCredentialStore['credentialFor']>>> => {
          const ranked = rankPool(await poolMembers({ region, store }), Date.now())
          for (const row of ranked) {
            if (row.excludedBy !== undefined) continue
            if (triedAccountIds.includes(row.account.id)) continue
            return store.credentialFor(row.account.id)
          }
          return undefined
        },
        failoverShortfall: async (): Promise<string | undefined> => {
          const ranked = rankPool(await poolMembers({ region, store }), Date.now())
          const excluded = ranked.filter(row => row.excludedBy !== undefined)
          if (excluded.length === 0) return undefined
          const reasons = [...new Set(excluded.map(row => EXCLUSION_TEXT[row.excludedBy as WorkBuddyPoolExclusion]))]
          return `池中其余账号都被排除：${reasons.join('、')}`
        },
        onAccountFailure: (accountId, failure): void => {
          void recordAccountFailure({ region }, accountId, {
            status: failure.status,
            message: failure.message,
            ...failure.modelId === undefined ? {} : { modelId: failure.modelId },
          }).catch(error => logger.warn(`${region} failure measurement not stored`, error))
        },
      } : {}),
    })
    await shim.ready
    stacks.set(region, { region, store, catalog, shim, modelIds: [] })
  }

  const writeStateFile = async (): Promise<void> => {
    const document: GatewayStateDocument = {
      version: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      stateDir,
      tokenFile: 'gateway-token',
      regions: Object.fromEntries([...stacks.values()].map(stack => [stack.region, {
        baseUrl: `${stack.shim.baseUrl()}/v1`,
        port: options.ports[stack.region],
        modelIds: stack.modelIds,
      }])),
    }
    await writeFileAtomic(join(stateDir, 'gateway.json'), `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  /**
   * Record whether this region has any local sign-in — the gate on what
   * /v1/models advertises.
   *
   * Awaited BEFORE `ready` is announced: until the first account scan lands,
   * a fresh catalog serves the static fallback with `usable` still true, and
   * a signed-out gateway would advertise models that can only 401 for the
   * first seconds of its life (a race the built e2e test caught under load).
   * The upstream host tolerated that window because its picker re-rendered;
   * a static consumer config does not.
   */
  const resolveUsable = async (stack: RegionStack): Promise<boolean> => {
    const accounts = await stack.store.accounts().catch(() => [])
    const usable = accounts.length > 0
    stack.catalog.setRegionUsable(usable)
    return usable
  }

  /** Refresh one region's live catalog; degrade to the fallback on failure. */
  const refreshCatalog = async (stack: RegionStack): Promise<void> => {
    const usable = await resolveUsable(stack)
    if (!usable) {
      stack.modelIds = []
      logger.warn(`${stack.region}: no local WorkBuddy sign-in; /v1/models serves nothing until you sign in`)
      return
    }
    const credential = await stack.store.resolve()
    const models = await client.fetchModels(credential)
    const enabled = await readEnabledModels(stateDir, stack.region)
    stack.catalog.set(deriveCatalog(models, enabled))
    stack.modelIds = stack.catalog.current().map(model => model.id)
    logger.warn(`${stack.region}: catalog refreshed — ${stack.modelIds.length} model(s)`)
  }

  const refreshAll = (): void => {
    for (const stack of stacks.values()) {
      void refreshCatalog(stack)
        .then(() => writeStateFile())
        .catch(error => logger.warn(`${stack.region}: catalog refresh failed; serving the static fallback`, error))
    }
  }

  // The sign-in gate lands BEFORE ready (see resolveUsable); the live roster
  // still arrives async — the static fallback answers /v1/models meanwhile,
  // exactly as in the host plugin.
  await Promise.all([...stacks.values()].map(stack => resolveUsable(stack)))
  refreshAll()
  const refreshTimer = setInterval(refreshAll, options.refreshMs)
  refreshTimer.unref()
  await writeStateFile()

  for (const stack of stacks.values()) {
    process.stdout.write([
      `workbuddy gateway: ${stack.region} serving ${stack.shim.baseUrl()} (port ${options.ports[stack.region]})`,
      `  token: ${join(stateDir, 'gateway-token')}`,
      `  hermes: model.provider=custom  model.base_url=${stack.shim.baseUrl()}/v1  model.api_key=<token>`,
      '',
    ].join('\n'))
  }
  process.stdout.write('workbuddy gateway: ready\n')

  await new Promise<void>(resolveShutdown => {
    let closing = false
    const shutdown = (signal: NodeJS.Signals): void => {
      if (closing) return
      closing = true
      process.stdout.write(`workbuddy gateway: ${signal} received, shutting down\n`)
      clearInterval(refreshTimer)
      void (async () => {
        for (const stack of stacks.values()) await stack.shim.close().catch(() => {})
        await rm(join(stateDir, 'gateway.json'), { force: true }).catch(() => {})
        resolveShutdown()
      })()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
}
