#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for the dsh-connect-workbuddy bundle.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
 *   — 三个子命令（`doctor` / `status` / `logout`）、`--json` 输出、
 *     `safeMessage` 脱敏、schemaVersion 字段、以及
 *     「宿主心跳 + 桌面端凭据文件 + 登录态」三项联合诊断的结构，
 *     均由该项目设计。
 * 改动：凭据诊断由单文件扩展为「目录扫描 + 按账号分组」，
 *     doctor 会列出发现的每个账号及其文件来源，便于确认多账号是否可用；
 *     另补 desktopAuthDir 字段。双 provider 化后，doctor/status 按
 *     区域（cn | global）分别报告各自的账号与登录态，logout 清除
 *     所有插件自有凭据副本（两个区域文件 + 旧单文件）。
 *
 * @module dsh-connect-workbuddy/bin
 */

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthDirs,
  legacyWorkbuddyOwnAuthPath,
  WORKBUDDY_AUTH_FILE_ENV,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
} from './auth.ts'
import { WORKBUDDY_APP_EXECUTABLE_ENV, findWorkbuddyAppExecutableWithSource } from './at-rest.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyRegion } from './upstream.ts'
import { FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_MODELS_GLOBAL, fallbackModelsFor } from './catalog.ts'
import {
  GATEWAY_DEFAULT_PORTS,
  GATEWAY_DEFAULT_REFRESH_MS,
  GATEWAY_REGIONS,
  readEnabledModels,
  readSelection,
  resolveStateDir,
  runGateway,
  useWorkbuddyStateDir,
  writeEnabledModels,
  writeSelection,
  type GatewayStateDocument,
} from './gateway.ts'
import { checkinAllAccounts } from './account-pool-run.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyHostHeartbeatPath } from './host-heartbeat.ts'
import { piAiRuntimeInfo } from './pi-ai-runtime.ts'
import { hostPeersInfo } from './host-peers.ts'
import { describeRosterSeenPayload, isKnownRosterSeenVersion, rosterSeenPath } from './roster-seen-store.ts'

type Action = 'doctor' | 'logout' | 'status' | 'serve' | 'models' | 'credits' | 'checkin' | 'account'

/** Actions added for standalone (host-less) use, e.g. behind Hermes. */
const STANDALONE_ACTIONS: ReadonlySet<string> = new Set(['serve', 'models', 'credits', 'checkin', 'account'])

/**
 * Version of the `doctor --json` document.
 *
 * 3 → 4: added `hostPeers` (issue #47). Consumers that switch on the version
 * see the field appear rather than having to guess whether its absence means
 * "old build" or "no peer".
 *
 * 4 → 5: added `rosterSeen`, so a first-sighting history that is corrupt or in
 * a version this build cannot read is REPORTED rather than silently answered as
 * "no new models".
 */
const JSON_SCHEMA_VERSION = 5

/** Both regions, in reporting order. */
const REGIONS: readonly WorkBuddyRegion[] = ['cn', 'global']

/** Region labels for human output. */
const REGION_LABELS: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'CN (domestic)',
  global: 'Global',
}

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: workbuddy <command> [options]',
    '',
    'Gateway (standalone OpenAI-compatible endpoint for Hermes and other clients):',
    '  serve     run the local gateway (per-region loopback port; stable port + token)',
    '            --region cn|global|both (default both)',
    '            --port N (cn port; global becomes N+1) / --port-cn N / --port-global N',
    '            --token STR (else the state dir\'s gateway-token, minted 0600 on first run)',
    '            --state-dir DIR (default $WORKBUDDY_STATE_DIR or $HERMES_HOME/workbuddy)',
    '            --no-pool (disable account-pool rotation/failover)',
    '            --refresh-minutes N (live catalog refresh, default 30)',
    '            --channel-perturbation off|failure|always   --keep-prompt-last',
    '',
    'Account & model management:',
    '  models    list a region\'s models, or edit its enable-list',
    '            --region cn|global (default cn)  --json',
    '            --enable id1,id2   --disable id1,id2   (persisted; gateway picks it up)',
    '  account   list / select the billing account for a region',
    '            --region cn|global (default cn)  [list] [<id|name>]  --clear',
    '  credits   per-account remaining credit   --region cn|global|both (default both) --json',
    '  checkin   claim every account\'s daily reward   --region cn|global|both (default both) --json',
    '',
    'Diagnostics (unchanged from the original plugin):',
    '  doctor    secret-free sign-in and environment diagnostics',
    '  status    per-region sign-in state, remaining credit, host-bundle health',
    '  logout    remove every plugin-owned credential copy (the desktop app keeps its sign-in)',
    '  --json    emit one secret-free JSON document (doctor/status only)',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** One region-scoped credential store (its own plugin-owned copy file). */
function makeStore(region: WorkBuddyRegion): WorkBuddyCredentialStore {
  const client = new WorkBuddyUpstreamClient()
  return new WorkBuddyCredentialStore({
    region,
    refresh: credential => client.refreshToken(credential),
  })
}

/** The region-unscoped store (reads every plugin-owned copy). */
function makeAnyStore(): WorkBuddyCredentialStore {
  const client = new WorkBuddyUpstreamClient()
  return new WorkBuddyCredentialStore({ refresh: credential => client.refreshToken(credential) })
}

/** One region's first-sighting history, as `doctor` reports it. */
type RosterSeenDoctorSummary = {
  path: string
  present: boolean
  readable: boolean
  versionKnown?: boolean
  version?: number
  ids?: number
  fresh?: number
}

/**
 * Read one region's first-sighting history and describe its payload.
 *
 * Read-only: this CLI never writes history, so running `doctor` cannot change
 * who counts as new. The point is that a corrupt file or one written by a newer
 * build is REPORTED here — without this, both would surface as "no new models",
 * which is a statement about this machine's catalogue and never a file.
 */
async function describeRosterSeen(region: WorkBuddyRegion): Promise<RosterSeenDoctorSummary> {
  const path = rosterSeenPath(region)
  let raw: unknown = null
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    // Missing file and malformed JSON are the same here: nothing recorded yet.
    raw = null
  }
  const described = describeRosterSeenPayload(raw)
  if (described === null) {
    return { path, present: raw !== null, readable: false }
  }
  const version = (raw as Record<string, unknown>)['version']
  return {
    path,
    present: true,
    readable: true,
    versionKnown: described.versionKnown,
    ...typeof version === 'number' ? { version } : {},
    ids: described.ids,
    fresh: described.fresh,
  }
}

async function doctor(jsonOutput: boolean): Promise<number> {
  const anyStore = makeAnyStore()
  const desktopPresent = await anyStore.desktopFilePresent()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  // Both the path AND how it was found: a registry hit and a default-layout hit
  // produce the same string, and only the source tells a user whether the
  // off-default-layout fallback is what saved them.
  const discoveredApp = findWorkbuddyAppExecutableWithSource()
  const appExecutable = discoveredApp?.executable
  const regionLists = await Promise.all(REGIONS.map(async region => ({
    region,
    accounts: await makeStore(region).accounts(),
  })))
  const anySignedIn = regionLists.some(({ accounts }) => accounts.length > 0)
  /**
   * Which pi-ai copy the PROVIDER resolves, and hence which context shape its
   * api consumes. This is the #24/#26 gate made visible: a legacy (0.85)
   * resolution while the DSH host normalizes with 0.87 is exactly the mixed
   * generation the adapter has to bridge, and the only way to SEE it is to
   * report it. `resolvedLocally: false` is the normal state of a market
   * install probed outside the host — inside DSH the host supplies pi-ai
   * (0.2.0+ ships 0.87.1, i.e. the pass-through branch). Nothing here reads
   * or reports key material.
   */
  const piAi = piAiRuntimeInfo()
  /**
   * Which atomic-write implementation this process would use (issue #47).
   *
   * The mirror of the `piAiRuntime` block below, for the same reason: the
   * plugin declares `@deepseek-ai/dsh-atomic-write` as a PEER, so inside a
   * booted host the host's copy is borrowed, while under `dsh plugin …
   * exec` the child resolves with stock Node rules and the peer is absent. A
   * missing peer used to be a load-time crash; it is now reported here so a
   * user can tell the two states apart without reading a stack trace.
   */
  const hostPeers = await hostPeersInfo()
  const rosterSeen = await Promise.all(REGIONS.map(async region => ({ region, summary: await describeRosterSeen(region) })))
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-connect-workbuddy',
    version: WORKBUDDY_CONNECT_VERSION,
    node: process.version,
    piAiRuntime: {
      generation: piAi.generation,
      version: piAi.version ?? (piAi.resolvedLocally ? '(unreadable)' : '(host-provided)'),
      resolvedFrom: piAi.resolvedFrom ?? '(host-provided; not resolvable outside DSH)',
      resolvedLocally: piAi.resolvedLocally,
      adapterBehaviour: piAi.generation === 'legacy'
        ? 'folds 0.87 transcripts (system text + tool state) into the 0.85 context shape'
        : piAi.resolvedLocally
          ? 'passes provider contexts through unchanged'
          : 'passes provider contexts through unchanged (pi-ai comes from the DSH host; 0.2.0+ ships 0.87.1)',
    },
    hostPeers: {
      atomicWrite: hostPeers.atomicWrite,
      behaviour: hostPeers.atomicWrite === 'host'
        ? 'using @deepseek-ai/dsh-atomic-write from the DSH host'
        : 'using the built-in copy: the host peer did not resolve here, which is the normal state outside a booted DSH (e.g. `dsh plugin … exec`)',
    },
    desktopAuthFile: {
      path: anyStore.desktopAuthPath() ?? '(no platform default; set WORKBUDDY_AUTH_FILE)',
      dir: defaultDesktopAuthDirs()[0] ?? '(no platform default)',
      candidates: defaultDesktopAuthCandidates(),
      present: desktopPresent,
    },
    /**
     * Whether the encrypted-credential path is available. The desktop app
     * encrypts token fields on Windows builds; opening them needs that same
     * app, so an install location is exactly what this records. No key
     * material is read or reported here.
     */
    atRestDecryption: {
      appExecutable: appExecutable ?? `(not found; set ${WORKBUDDY_APP_EXECUTABLE_ENV})`,
      /**
       * Where the path came from. `registry` means the app is installed outside
       * the default layout and the Windows uninstall registration found it; the
       * absence of this field (older reports) is why the hint below can now name
       * the mechanism instead of telling every user to set the env var.
       */
      appExecutableSource: discoveredApp?.source,
      available: appExecutable !== undefined,
    },
    ownAuthFiles: {
      cn: workbuddyOwnAuthPath('cn'),
      global: workbuddyOwnAuthPath('global'),
      legacy: legacyWorkbuddyOwnAuthPath(),
    },
    hostHeartbeat: {
      path: workbuddyHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    regions: Object.fromEntries(regionLists.map(({ region, accounts }) => [region, accounts.map(account => ({
      id: account.id,
      accountName: account.accountName,
      domain: account.domain === '' ? undefined : account.domain,
      source: account.source,
      selected: account.selected,
      tokenExpiresAt: new Date(account.tokenExpiresAtMs).toISOString(),
    }))])),
    fallbackModels: {
      cn: FALLBACK_WORKBUDDY_MODELS.length,
      global: FALLBACK_WORKBUDDY_MODELS_GLOBAL.length,
    },
    // The first-sighting histories behind the "· N 新模型" segment. Reported so
    // a file this build cannot read is VISIBLE: without this block it would
    // surface as "no new models", which is a statement about the catalogue.
    rosterSeen: Object.fromEntries(rosterSeen.map(({ region, summary }) => [region, summary])),
    hints: [
      ...anySignedIn ? [] : ['Sign in once in the WorkBuddy desktop app (either region), then run status again.'],
      ...desktopPresent ? [] : [`No WorkBuddy desktop auth file at the expected path; set ${WORKBUDDY_AUTH_FILE_ENV} if it lives elsewhere.`],
      ...appExecutable === undefined
        ? [`The WorkBuddy desktop app was not found, so encrypted credential fields cannot be opened. On Windows the install registration was already checked, so the app is either not installed or its uninstall entry is missing; set ${WORKBUDDY_APP_EXECUTABLE_ENV} to its executable if it is installed elsewhere.`]
        : [],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and providers are unavailable until DSH starts the plugin.'],
      ...piAi.generation === 'legacy' && piAi.resolvedLocally
        ? [`This plugin resolves pi-ai ${piAi.version ?? '(unreadable version)'} (the 0.85 context shape) while DSH 0.2.0+ hosts normalize with 0.87; the adapter bridges that gap, but if tools still misbehave, remove any nested pi-ai copy so the plugin resolves the host's.`]
        : [],
      ...rosterSeen.flatMap(({ region, summary }) => {
        if (!summary.readable) {
          return summary.present
            ? [`${REGION_LABELS[region]} first-sighting history is present but unreadable (${summary.path}); remove it to reseed on the next reconcile.`]
            : []
        }
        if (summary.versionKnown === false) {
          return [`${REGION_LABELS[region]} first-sighting history is version ${summary.version === undefined ? 'unknown' : summary.version}, which this build cannot read (${summary.path}); it is answered as empty, so the pill shows no new-model marker.`]
        }
        return []
      }),
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `WorkBuddy Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
      ...piAi.resolvedLocally
        ? [`pi-ai runtime: ${piAi.generation}${piAi.version === undefined ? '' : ` ${piAi.version}`} (${piAi.resolvedFrom}) — ${report.piAiRuntime.adapterBehaviour}`]
        : [`pi-ai runtime: ${piAi.generation}, host-provided (no local copy; DSH 0.2.0+ ships 0.87.1) — passes provider contexts through unchanged`],
      `Atomic writes: ${hostPeers.atomicWrite === 'host' ? 'host-provided (@deepseek-ai/dsh-atomic-write)' : 'built-in copy (host peer not resolvable here; normal outside a booted DSH)'}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} (${report.desktopAuthFile.path})`,
      `Encrypted-credential support: ${report.atRestDecryption.available ? 'available' : 'unavailable'} (${report.atRestDecryption.appExecutable}${report.atRestDecryption.appExecutableSource === undefined ? '' : `, via ${report.atRestDecryption.appExecutableSource}`})`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      ...regionLists.flatMap(({ region, accounts }) => [
        `${REGION_LABELS[region]} accounts: ${accounts.length} (own copy ${workbuddyOwnAuthPath(region)})`,
        ...accounts.map(account => `  - ${account.accountName === '' ? '(unnamed)' : account.accountName} (${account.id})${account.selected ? ' [selected]' : ''} expires ${new Date(account.tokenExpiresAtMs).toISOString()}`),
      ]),
      `Static fallback models: CN ${report.fallbackModels.cn}, Global ${report.fallbackModels.global}`,
      ...REGIONS.map(region => {
        const summary = report.rosterSeen[region]
        if (summary === undefined) return `New-model history (${REGION_LABELS[region]}): not available`
        if (!summary.readable) return `New-model history (${REGION_LABELS[region]}): ${summary.present ? 'unreadable' : 'not started'} (${summary.path})`
        if (summary.versionKnown === false) return `New-model history (${REGION_LABELS[region]}): version ${summary.version === undefined ? 'unknown' : summary.version} not readable (${summary.path})`
        return `New-model history (${REGION_LABELS[region]}): ${summary.ids ?? 0} recorded, ${summary.fresh ?? 0} new`
      }),
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return anySignedIn && desktopPresent ? 0 : 1
}

/** One region's sign-in and credit summary. */
async function regionStatus(region: WorkBuddyRegion): Promise<{
  region: WorkBuddyRegion
  status: 'signed-in' | 'signed-out'
  accessTokenExpires?: string
  nickname?: string
  domain?: string
  accountId?: string
  accountName?: string
  accountCount: number
  credits?: number
  creditsError?: string
}> {
  const store = makeStore(region)
  const client = new WorkBuddyUpstreamClient()
  const authStatus = await store.status()
  const accounts = await store.accounts()
  const selected = accounts.find(account => account.selected)
  const base = {
    region,
    status: authStatus.state,
    ...authStatus.expiresAtMs === undefined ? {} : { accessTokenExpires: new Date(authStatus.expiresAtMs).toISOString() },
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...selected === undefined ? {} : { accountId: selected.id, accountName: selected.accountName },
    accountCount: accounts.length,
  }
  if (authStatus.state !== 'signed-in') return base
  try {
    const credential = await store.resolve()
    return { ...base, credits: (await client.fetchCredits(credential)).total }
  } catch (error: unknown) {
    return { ...base, credits: 0, creditsError: safeMessage(error) }
  }
}

async function status(jsonOutput: boolean): Promise<number> {
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  const fragments = await Promise.all(REGIONS.map(region => regionStatus(region)))
  const cn = fragments.find(fragment => fragment.region === 'cn')
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-connect-workbuddy',
      version: WORKBUDDY_CONNECT_VERSION,
      // Top-level fields mirror the CN region for pre-dual-provider readers.
      status: cn?.status === 'signed-in' ? 'signed-in' : 'signed-out',
      ...cn?.status === 'signed-in' ? {
        ...cn.accessTokenExpires === undefined ? {} : { accessTokenExpires: cn.accessTokenExpires },
        ...cn.nickname === undefined ? {} : { nickname: cn.nickname },
        ...cn.domain === undefined ? {} : { domain: cn.domain },
        ...cn.accountId === undefined ? {} : { accountId: cn.accountId, accountName: cn.accountName },
      } : {},
      regions: Object.fromEntries(fragments.map(fragment => [fragment.region, fragment])),
      hostBundle: hostState,
    })
    return fragments.some(fragment => fragment.status === 'signed-in') ? 0 : 1
  }
  process.stdout.write([
    ...fragments.flatMap(fragment => [
      `${REGION_LABELS[fragment.region]}: ${fragment.status === 'signed-in'
        ? `signed in${fragment.accountName === undefined ? '' : ` as ${fragment.accountName}`}`
        : 'signed out'}`,
      ...fragment.status === 'signed-in' && fragment.accessTokenExpires !== undefined
        ? [`  Access token expires ${fragment.accessTokenExpires} (refresh is automatic)`] : [],
      `  Local accounts: ${fragment.accountCount}`,
      ...fragment.creditsError !== undefined
        ? [`  Remaining credit: unavailable (${fragment.creditsError})`]
        : fragment.credits !== undefined
          ? [`  Remaining credit: ${fragment.credits}`]
          : [],
    ]),
    `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
    'Client card: load failures are logged to the browser console only; the host providers are unaffected.',
    ...(await describeGatewayLines()),
    '',
  ].join('\n'))
  return fragments.some(fragment => fragment.status === 'signed-in') ? 0 : 1
}

// ---------------------------------------------------------------------------
// Standalone gateway commands — added so this core can serve consumers other
// than the DSH host (Hermes, wired in as an OpenAI-compatible custom
// provider). The original doctor/status/logout are untouched above.
// ---------------------------------------------------------------------------

/** Parse an argv tail of `--flag`, `--key value`, `--key=value`, positionals. */
function parseFlags(argv: readonly string[]): {
  flags: ReadonlySet<string>
  values: ReadonlyMap<string, string>
  positionals: readonly string[]
} {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    if (equals !== -1) {
      values.set(arg.slice(2, equals), arg.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values.set(arg.slice(2), next)
      index += 1
      continue
    }
    flags.add(arg.slice(2))
  }
  return { flags, values, positionals }
}

/** Resolve `--region` into the region list a command should act on. */
function parseRegions(value: string | undefined, fallback: readonly WorkBuddyRegion[]): readonly WorkBuddyRegion[] {
  if (value === undefined) return fallback
  if (value === 'both') return GATEWAY_REGIONS
  if (value === 'cn' || value === 'global') return [value]
  throw new Error(`--region must be cn, global, or both; got ${JSON.stringify(value)}`)
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`port must be an integer in 1024..65535; got ${JSON.stringify(value)}`)
  }
  return port
}

/** `workbuddy serve` — run the OpenAI-compatible gateway until a signal lands. */
async function serveCommand(argv: readonly string[]): Promise<number> {
  const { flags, values } = parseFlags(argv)
  const regions = parseRegions(values.get('region'), GATEWAY_REGIONS)
  const basePort = values.get('port')
  const ports: Record<WorkBuddyRegion, number> = {
    cn: parsePort(values.get('port-cn') ?? basePort, GATEWAY_DEFAULT_PORTS.cn),
    // With a single --port the second region steps aside by one rather than
    // colliding: two regions on one port would silently shadow each other.
    global: parsePort(
      values.get('port-global') ?? (basePort === undefined ? undefined : String(Number(basePort) + 1)),
      GATEWAY_DEFAULT_PORTS.global,
    ),
  }
  if (regions.length === 2 && ports.cn === ports.global) {
    throw new Error(`both regions cannot share port ${ports.cn}; pass --port-cn/--port-global`)
  }
  const perturbation = values.get('channel-perturbation') ?? 'failure'
  if (perturbation !== 'off' && perturbation !== 'failure' && perturbation !== 'always') {
    throw new Error(`--channel-perturbation must be off, failure, or always; got ${JSON.stringify(perturbation)}`)
  }
  const refreshMinutes = values.get('refresh-minutes')
  if (refreshMinutes !== undefined) {
    const minutes = Number(refreshMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error(`--refresh-minutes must be a positive number; got ${JSON.stringify(refreshMinutes)}`)
    }
  }
  const token = values.get('token')
  await runGateway({
    regions,
    ports,
    ...token === undefined ? {} : { token },
    stateDir: values.get('state-dir') ?? resolveStateDir(),
    pool: !flags.has('no-pool'),
    refreshMs: refreshMinutes === undefined
      ? GATEWAY_DEFAULT_REFRESH_MS
      : Math.round(Number(refreshMinutes) * 60_000),
    channelPerturbation: perturbation,
    keepPromptLast: flags.has('keep-prompt-last'),
  })
  return 0
}

/** One printable row of `workbuddy models`. */
interface ModelRow {
  id: string
  name?: string
  contextWindow?: number
  creditMultiplier?: number
  supportsImages?: boolean
  reasoning?: unknown
}

function modelRowOf(model: {
  id: string
  name?: string
  contextWindow?: number
  creditMultiplier?: number
  supportsImages?: boolean
  reasoning?: unknown
}): ModelRow {
  return {
    id: model.id,
    ...model.name === undefined ? {} : { name: model.name },
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.creditMultiplier === undefined ? {} : { creditMultiplier: model.creditMultiplier },
    ...model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages },
    ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
  }
}

/** `workbuddy models` — list a region's models or edit its enable-list. */
async function modelsCommand(argv: readonly string[]): Promise<number> {
  const { flags, values } = parseFlags(argv)
  const region = parseRegions(values.get('region'), ['cn'] as const)[0] as WorkBuddyRegion
  const stateDir = values.get('state-dir') ?? resolveStateDir()
  const current = await readEnabledModels(stateDir, region)
  const enable = values.get('enable')
  const disable = values.get('disable')
  if (enable !== undefined || disable !== undefined) {
    const next = new Set(current)
    for (const id of splitList(enable)) next.add(id)
    for (const id of splitList(disable)) next.delete(id)
    await writeEnabledModels(stateDir, region, [...next])
    process.stdout.write(next.size === 0
      ? `${region}: no enable-list kept; every discovered model is served\n`
      : `${region}: enable-list saved (${next.size}): ${[...next].join(', ')}\n`)
    return 0
  }
  const store = makeStore(region)
  const client = new WorkBuddyUpstreamClient()
  let rows: readonly ModelRow[]
  let source: 'live' | 'fallback'
  try {
    const credential = await store.resolve()
    rows = (await client.fetchModels(credential)).map(modelRowOf)
    source = 'live'
  } catch {
    rows = fallbackModelsFor(region).map(modelRowOf)
    source = 'fallback'
  }
  // The enable-list filters what is ADVERTISED, mirroring deriveCatalog: an
  // empty list means everything, and a list that matches nothing degrades to
  // everything rather than to a region with no models at all.
  const visible = current.size === 0
    ? rows
    : rows.filter(row => current.has(row.id))
  const served = visible.length === 0 && current.size > 0 ? rows : visible
  if (values.has('json') || flags.has('json')) {
    printJson({ region, source, enabled: [...current], models: served })
    return 0
  }
  process.stdout.write([
    `${REGION_LABELS[region]} models (${source}${source === 'fallback' ? ' — no local sign-in or upstream unreachable; run `workbuddy status`' : ''}): ${served.length}`,
    ...served.map(row => [
      `  ${row.id}`,
      row.name === undefined ? '' : ` — ${row.name}`,
      row.contextWindow === undefined ? '' : ` · ctx ${row.contextWindow}`,
      row.creditMultiplier === undefined ? '' : ` · ×${row.creditMultiplier} credits`,
      row.supportsImages === true ? ' · images' : '',
    ].join('')),
    '',
  ].join('\n'))
  return 0
}

function splitList(value: string | undefined): readonly string[] {
  return (value ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

/** `workbuddy credits` — remaining credit per account, per region. */
async function creditsCommand(argv: readonly string[]): Promise<number> {
  const { flags, values } = parseFlags(argv)
  const regions = parseRegions(values.get('region'), GATEWAY_REGIONS)
  const client = new WorkBuddyUpstreamClient()
  const report: Record<string, unknown> = {}
  const lines: string[] = []
  let anyCredit = false
  for (const region of regions) {
    const store = makeStore(region)
    const accounts = await store.accounts()
    const rows = []
    for (const account of accounts) {
      const credential = await store.credentialFor(account.id)
      if (credential === undefined) continue
      try {
        const credits = await client.fetchCredits(credential)
        anyCredit = true
        rows.push({
          accountId: account.id,
          accountName: account.accountName === '' ? '(unnamed)' : account.accountName,
          total: credits.total,
          expiringSoon: credits.expiringSoon,
          ...credits.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
        })
      } catch (error: unknown) {
        rows.push({
          accountId: account.id,
          accountName: account.accountName === '' ? '(unnamed)' : account.accountName,
          error: safeMessage(error),
        })
      }
    }
    report[region] = rows
    lines.push(
      `${REGION_LABELS[region]}:`,
      ...rows.length === 0
        ? ['  (no local accounts)']
        : rows.map(row => {
          const record = row as { accountName: string, total?: number, expiringSoon?: number, error?: string }
          return record.error === undefined
            ? `  ${record.accountName}: ${record.total} credit${record.expiringSoon ? ` (${record.expiringSoon} expiring soon)` : ''}`
            : `  ${record.accountName}: unavailable (${record.error})`
        }),
    )
  }
  if (flags.has('json') || values.has('json')) {
    printJson(report)
    return 0
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return anyCredit ? 0 : 1
}

/** `workbuddy checkin` — claim every account's daily reward. */
async function checkinCommand(argv: readonly string[]): Promise<number> {
  const { flags, values } = parseFlags(argv)
  const regions = parseRegions(values.get('region'), GATEWAY_REGIONS)
  const client = new WorkBuddyUpstreamClient()
  const report: Record<string, unknown> = {}
  const lines: string[] = []
  let anySuccess = false
  for (const region of regions) {
    const store = makeStore(region)
    const accounts = await store.accounts()
    const rows = await checkinAllAccounts(
      accounts.map(account => ({
        accountId: account.id,
        accountName: account.accountName,
        ...account.enterprise === undefined ? {} : { enterprise: account.enterprise },
      })),
      {
        credentialFor: accountId => store.credentialFor(accountId),
        fetchCheckinStatus: credential => client.fetchCheckinStatus(credential),
        claimDailyCheckin: credential => client.claimDailyCheckin(credential),
        // checkinAllAccounts never probes; the dep exists for the shared
        // runner shape, and a stub that throws keeps that claim honest.
        probe: async () => { throw new Error('probe is not part of the checkin command') },
      },
    )
    for (const row of rows) {
      if (row.status === 'claimed') anySuccess = true
    }
    report[region] = rows
    lines.push(
      `${REGION_LABELS[region]}:`,
      ...rows.length === 0
        ? ['  (no local accounts)']
        : rows.map(row => [
          `  ${row.accountName === '' ? row.accountId : row.accountName}: ${row.status}`,
          row.credit === undefined ? '' : ` +${row.credit}`,
          row.streakDays === undefined ? '' : ` (streak ${row.streakDays}d)`,
          row.message === undefined ? '' : ` — ${row.message}`,
        ].join('')),
    )
  }
  if (flags.has('json') || values.has('json')) {
    printJson(report)
    return 0
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return anySuccess ? 0 : 1
}

/** `workbuddy account` — list, select, or clear the billing account. */
async function accountCommand(argv: readonly string[]): Promise<number> {
  const { flags, positionals, values } = parseFlags(argv)
  const region = parseRegions(values.get('region'), ['cn'] as const)[0] as WorkBuddyRegion
  const stateDir = values.get('state-dir') ?? resolveStateDir()
  const store = makeStore(region)
  if (flags.has('clear')) {
    await writeSelection(stateDir, region, undefined)
    store.selectAccount(undefined)
    process.stdout.write(`${region}: selection cleared; the gateway follows the newest sign-in\n`)
    return 0
  }
  const accounts = await store.accounts()
  const selected = await readSelection(stateDir, region)
  if (positionals.length === 0) {
    process.stdout.write([
      `${REGION_LABELS[region]} accounts: ${accounts.length}`,
      ...accounts.map(account => `  - ${account.accountName === '' ? '(unnamed)' : account.accountName} (${account.id})${account.id === selected ? ' [selected]' : ''}${account.enterprise === true ? ' [enterprise]' : ''} expires ${new Date(account.tokenExpiresAtMs).toISOString()}`),
      '',
    ].join('\n'))
    return 0
  }
  const query = positionals[0] as string
  const match = accounts.find(account => account.id === query)
    ?? accounts.find(account => account.accountName !== '' && account.accountName === query)
  if (match === undefined) {
    process.stderr.write(`workbuddy: no ${region} account matches ${JSON.stringify(query)}; see \`workbuddy account --region ${region}\`\n`)
    return 1
  }
  await writeSelection(stateDir, region, match.id)
  store.selectAccount(match.id)
  process.stdout.write(`${region}: billing account set to ${match.accountName === '' ? match.id : `${match.accountName} (${match.id})`}; a running gateway applies it on the next request\n`)
  return 0
}

/** Whether a pid is alive; used only to label a stale gateway state file. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** What `status` adds about a running gateway, if its state file exists. */
async function describeGatewayLines(): Promise<readonly string[]> {
  const stateDir = resolveStateDir()
  let document: GatewayStateDocument
  try {
    document = JSON.parse(await readFile(join(stateDir, 'gateway.json'), 'utf8')) as GatewayStateDocument
  } catch {
    return ['Gateway: not started (no state file; run `workbuddy serve`)']
  }
  const alive = isPidAlive(document.pid)
  return [
    `Gateway: ${alive ? `running (pid ${document.pid}, started ${document.startedAt})` : 'not running (stale state file)'}`,
    ...Object.entries(document.regions).map(([region, info]) =>
      `  ${region}: ${info.baseUrl} — ${info.modelIds.length} live model(s)`),
  ]
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  // Every command operates on ONE state directory — the gateway's, by
  // default — so `serve` and the read-only commands can never disagree about
  // where the credential copies and selection files live. An already-set
  // $DSH_HOME (a wrapper, a test) is obeyed, not overwritten.
  useWorkbuddyStateDir(resolveStateDir())
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  if (rawAction !== undefined && STANDALONE_ACTIONS.has(rawAction)) {
    try {
      switch (rawAction as Action) {
        case 'serve':
          return await serveCommand(flags)
        case 'models':
          return await modelsCommand(flags)
        case 'credits':
          return await creditsCommand(flags)
        case 'checkin':
          return await checkinCommand(flags)
        case 'account':
          return await accountCommand(flags)
        default:
          return 1
      }
    } catch (error: unknown) {
      process.stderr.write(`workbuddy: ${rawAction} failed: ${safeMessage(error)}\n`)
      return 1
    }
  }
  const actions: readonly Action[] = ['doctor', 'logout', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`workbuddy: unknown command ${JSON.stringify(rawAction)}; expected serve, models, account, credits, checkin, doctor, status, or logout (see --help)\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')
  const unknown = flags.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-connect-workbuddy: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput)
      case 'status':
        return await status(jsonOutput)
      case 'logout': {
        // The unscoped store's logout removes every plugin-owned copy:
        // both per-region files and the legacy single file.
        const store = makeAnyStore()
        await store.logout()
        process.stdout.write(`WorkBuddy Connect: removed the plugin-owned credential copies (${workbuddyOwnAuthPath('cn')}, ${workbuddyOwnAuthPath('global')}, ${legacyWorkbuddyOwnAuthPath()}); the desktop app's sign-in is untouched\n`)
        return 0
      }
      default:
        return 1
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-connect-workbuddy: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
