import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ROSTER_SEEN_MAX_IDS,
  ROSTER_SEEN_NEW_WINDOW_MS,
  createFileRosterSeenStore,
  describeRosterSeenPayload,
  freshIdsOf,
  isKnownRosterSeenVersion,
  normalizeRosterSeen,
  rosterSeenPath,
} from '../src/roster-seen-store.ts'
import type { WorkBuddyRegion } from '../src/upstream.ts'

/**
 * The store takes an explicit `dir`, so these tests never touch a real profile
 * (unlike the stores that read `$DSH_HOME`).
 */
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-roster-seen-'))
})
afterEach(async () => {
  await rm(home, { force: true, recursive: true })
})

const DAY = 24 * 60 * 60 * 1000
/** A fixed "now" so no test depends on the wall clock. */
const T0 = Date.UTC(2026, 0, 10)

const storeOf = (region: WorkBuddyRegion) => createFileRosterSeenStore(region, { dir: home })

/** Read one region's on-disk payload. */
async function readPayloadOf(region: WorkBuddyRegion): Promise<{ seen: Record<string, number>; version: number | null }> {
  return JSON.parse(await readFile(rosterSeenPath(region, home), 'utf8')) as { seen: Record<string, number>; version: number | null }
}

describe('isKnownRosterSeenVersion', () => {
  it('accepts the version this build writes and nothing else', () => {
    expect(isKnownRosterSeenVersion(1)).toBe(true)
    expect(isKnownRosterSeenVersion(2)).toBe(false)
    expect(isKnownRosterSeenVersion(0)).toBe(false)
    // A string is not a version even when it spells one: a newer build may have
    // changed the field's type, and reading it as 1 would mis-parse the payload.
    expect(isKnownRosterSeenVersion('1')).toBe(false)
    expect(isKnownRosterSeenVersion(undefined)).toBe(false)
  })
})

describe('normalizeRosterSeen', () => {
  it('reads nothing for a payload that is not an object', () => {
    expect(normalizeRosterSeen(null)).toEqual({})
    expect(normalizeRosterSeen([])).toEqual({})
    expect(normalizeRosterSeen('nope')).toEqual({})
  })

  it('drops ids that are empty and stamps that are not a finite positive number', () => {
    // A zero or negative stamp would make `now - stamp` come out as decades, so
    // that id would count as "new" forever. Dropping is the repair: it takes a
    // real stamp the next time it appears.
    expect(normalizeRosterSeen({
      '': T0,
      'ok': T0,
      'zero': 0,
      'negative': -1,
      'nan': Number.NaN,
      'infinite': Number.POSITIVE_INFINITY,
      'string': 'nope',
      'null': null,
    })).toEqual({ ok: T0 })
  })
})

describe('freshIdsOf', () => {
  it('answers ids inside the window oldest first', () => {
    // Ascending on purpose: the pill shows only the first few names, and the ones
    // seen EARLIEST are the ones closest to expiring.
    expect(freshIdsOf({ late: T0 - 1000, early: T0 - 50_000, middle: T0 - 10_000 }, T0))
      .toEqual(['early', 'middle', 'late'])
  })

  it('treats a stamp exactly one window old as expired', () => {
    expect(freshIdsOf({ model: T0 - ROSTER_SEEN_NEW_WINDOW_MS }, T0)).toEqual([])
    expect(freshIdsOf({ model: T0 - ROSTER_SEEN_NEW_WINDOW_MS + 1 }, T0)).toEqual(['model'])
  })
})

describe('the first write after upgrade is seeding, not announcing', () => {
  it('returns an empty new-list and stamps every id as already expired', async () => {
    const store = storeOf('cn')
    // At this moment we KNOW the catalog holds these models but do NOT know which
    // of them are new. Announcing the whole catalog as "just added" is the lie
    // this file exists to avoid.
    expect(await store.note(['alpha', 'beta'], T0)).toEqual({ newIds: [] })
    const written = await readPayloadOf('cn')
    // Both ids were stamped `T0 - window`, so a round a second later finds
    // nothing new — and neither will ever be announced by this build again.
    expect(written['seen']['alpha']).toBe(T0 - ROSTER_SEEN_NEW_WINDOW_MS)
    expect(await store.fresh(T0 + 1000)).toEqual([])
  })
})

describe('note', () => {
  it('announces exactly the ids that entered the roster since the last round', async () => {
    const store = storeOf('cn')
    await store.note(['alpha'], T0)
    // A new id inside the window, and an already-known id that must not be
    // re-announced even though it has not been seen since.
    expect(await store.note(['alpha', 'beta'], T0)).toEqual({ newIds: ['beta'] })
    // Once the window passes, the marker is gone rather than stuck.
    expect(await store.fresh(T0 + ROSTER_SEEN_NEW_WINDOW_MS + 1)).toEqual([])
  })

  it('dedupes and drops blank ids', async () => {
    const store = storeOf('cn')
    await store.note(['alpha', 'alpha', ''], T0)
    const written = await readPayloadOf('cn')
    expect(Object.keys(written['seen'])).toEqual(['alpha'])
  })

  it('records nothing for an empty round and never clears the table', async () => {
    const store = storeOf('cn')
    await store.note(['alpha'], T0)
    // A transient empty catalog must NOT read as "everything was delisted":
    // writing that empties the table, and the next round re-stamps and announces
    // everything as new.
    expect(await store.note([], T0)).toEqual({ newIds: [] })
    expect(await store.note(['alpha', 'beta'], T0)).toEqual({ newIds: ['beta'] })
  })

  it('treats an id that left the roster and came back as newly-seen again', async () => {
    const store = storeOf('cn')
    await store.note(['alpha', 'beta'], T0)
    // beta delisted: dropped from the table.
    await store.note(['alpha'], T0 + DAY)
    // beta is back. Because its stamp was dropped when it left, it counts as a
    // fresh first sighting — exactly the "it came back" case a reader cares about.
    expect(await store.note(['alpha', 'beta'], T0 + 2 * DAY)).toEqual({ newIds: ['beta'] })
  })

  it('clamps a future stamp to now so it cannot stay new forever', async () => {
    const store = storeOf('cn')
    await store.note(['alpha'], T0)
    // A clock rollback or a hand-edited file left a future stamp on `beta`.
    const path = rosterSeenPath('cn', home)
    const payload = JSON.parse(await readFile(path, 'utf8')) as { seen: Record<string, number> }
    payload['seen']['beta'] = T0 + 10 * DAY
    await writeFile(path, `${JSON.stringify(payload)}\n`)
    await store.note(['alpha', 'beta'], T0)
    const written = await readPayloadOf('cn')
    expect(written['seen']['beta']).toBeLessThanOrEqual(T0)
    // Had the future stamp survived, `beta` would still be inside the window here.
    expect(await store.fresh(T0 + ROSTER_SEEN_NEW_WINDOW_MS + 1)).toEqual([])
  })

  it('treats an over-cap catalog as shape drift: nothing written, nothing announced', async () => {
    const store = storeOf('cn')
    const first = Array.from({ length: ROSTER_SEEN_MAX_IDS }, (_, index) => `m${index}`)
    await store.note(first, T0)
    // Evicting by "keep the newest" would make a still-present id look unseen
    // next round, re-stamp it, and re-announce it — and the evicted set rotates,
    // so the count oscillates and grows. A history file that invents its own new
    // models is worse than no file, so the round is neither written nor announced.
    expect(await store.note([...first, 'm-over'], T0)).toEqual({ newIds: [] })
    const written = await readPayloadOf('cn')
    expect(Object.keys(written['seen'])).toHaveLength(ROSTER_SEEN_MAX_IDS)
    expect(written['seen']['m-over']).toBeUndefined()
  })

  it('keeps each region on its own first-sighting table', async () => {
    const cn = storeOf('cn')
    const global = storeOf('global')
    await cn.note(['alpha'], T0)
    // The global table has never been written, so ITS first round is a seeding
    // round too: `beta` is recorded, not announced.
    expect(await global.note(['beta'], T0)).toEqual({ newIds: [] })
    // A CN first-sighting never crosses into the global table.
    const globalWritten = await readPayloadOf('global')
    expect(globalWritten['seen']['alpha']).toBeUndefined()
    expect(Object.keys(globalWritten['seen'])).toEqual(['beta'])
    expect(await global.note(['beta', 'gamma'], T0)).toEqual({ newIds: ['gamma'] })
  })

  it('stops without writing or announcing when the stored version is unknown', async () => {
    const store = storeOf('cn')
    const path = rosterSeenPath('cn', home)
    // A payload written by a build newer than this one.
    await writeFile(path, `${JSON.stringify({ version: 2, seen: { alpha: T0 } })}\n`)
    expect(await store.note(['alpha', 'beta'], T0)).toEqual({ newIds: [] })
    // The newer build's history was NOT overwritten: an older build reconciling
    // must never empty a newer build's file.
    const written = await readPayloadOf('cn')
    expect(written['version']).toBe(2)
    expect(written['seen']).toEqual({ alpha: T0 })
    // And the read side says why rather than silently answering "no new models".
    const readout = await store.readout(T0)
    expect(readout['newModelIds']).toEqual([])
    expect(readout['versionNote']).toContain('version 2')
  })
})

describe('describeRosterSeenPayload', () => {
  it('returns null for a payload it cannot recognise at all', () => {
    expect(describeRosterSeenPayload(null)).toBeNull()
    expect(describeRosterSeenPayload([])).toBeNull()
    // A payload that does not state its version is not something this shape can
    // read — reporting "0 recorded" would be a claim about nothing.
    expect(describeRosterSeenPayload({ seen: {} })).toBeNull()
  })

  it('distinguishes a readable version from a newer one', () => {
    const now = Date.now()
    expect(describeRosterSeenPayload({ version: 1, seen: { alpha: now } }))
      .toEqual({ versionKnown: true, ids: 1, fresh: 1 })
    expect(describeRosterSeenPayload({ version: 2, seen: { alpha: now } }))
      .toEqual({ versionKnown: false, ids: 1, fresh: 1 })
  })
})