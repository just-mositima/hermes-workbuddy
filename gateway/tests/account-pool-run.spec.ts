import { describe, expect, it, vi } from 'vitest'
import {
  checkinAllAccounts,
  POOL_BATCH_GAP_MS,
  probeUpdatesOf,
  testAllAccounts,
  travelAllAccounts,
} from '../src/account-pool-run.ts'
import type {
  WorkBuddyPoolRunnerDeps,
  WorkBuddyPoolTarget,
  WorkBuddyPoolTestRow,
  WorkBuddyPoolTravelDeps,
} from '../src/account-pool-run.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyProbeResult } from '../src/probe.ts'

function credential(id: string): WorkBuddyCredential {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAtMs: Date.now() + 86_400_000,
    domain: 'www.codebuddy.cn',
    uid: `uid-${id}`,
    uin: id,
    nickname: id,
    source: 'desktop',
    filePath: `/tmp/${id}.info`,
  }
}

const TARGETS: readonly WorkBuddyPoolTarget[] = [
  { accountId: 'a', accountName: 'Alpha' },
  { accountId: 'b', accountName: 'Beta' },
  { accountId: 'c', accountName: 'Gamma' },
]

/** Credentials by account id; a missing entry simulates an unreachable store. */
function credentialsFor(ids: readonly string[]): WorkBuddyPoolRunnerDeps['credentialFor'] {
  return async (accountId: string) => ids.includes(accountId) ? credential(accountId) : undefined
}

/** A runner double with no real delays and per-account scripted answers. */
function runner(
  overrides: Partial<WorkBuddyPoolRunnerDeps> & {
    checked?: Record<string, boolean>
  } = {},
): WorkBuddyPoolRunnerDeps & { calls: string[] } {
  const calls: string[] = []
  const checked = overrides.checked ?? {}
  return {
    calls,
    credentialFor: overrides.credentialFor ?? credentialsFor(['a', 'b', 'c']),
    fetchCheckinStatus: overrides.fetchCheckinStatus ?? (async (cred: WorkBuddyCredential) => {
      calls.push(`status:${cred.uin}`)
      return {
        active: true,
        todayCheckedIn: checked[cred.uin ?? ''] === true,
        streakDays: 1,
        dailyCredit: 60,
        todayCredit: 0,
        isStreakDay: false,
        nextStreakDay: 2,
        streakBonusDays: 0,
        streakBonusCredit: 0,
      }
    }),
    claimDailyCheckin: overrides.claimDailyCheckin ?? (async (cred: WorkBuddyCredential) => {
      calls.push(`claim:${cred.uin}`)
      return { credit: 60, streakDays: 7 }
    }),
    probe: overrides.probe ?? (async (cred: WorkBuddyCredential, modelId: string) => {
      calls.push(`probe:${cred.uin}:${modelId}`)
      return { modelId, outcome: 'ok', elapsedMs: 1_000 } as WorkBuddyProbeResult
    }),
    wait: async () => {},
  }
}

describe('checkinAllAccounts', () => {
  it('claims for every account that has not checked in', async () => {
    const deps = runner()
    const rows = await checkinAllAccounts(TARGETS, deps)
    expect(rows.map(row => row.status)).toEqual(['claimed', 'claimed', 'claimed'])
    expect(rows[0]?.credit).toBe(60)
    expect(rows[0]?.streakDays).toBe(7)
  })

  it('skips an enterprise account without spending a request on it (issue #124)', async () => {
    // The enterprise gateway has no consumer check-in: it answers 10001 for
    // every member. Spending two requests to learn a predictable refusal, and
    // then showing it as a failure in a column that never applies, is worse
    // than saying "not offered here".
    const deps = runner()
    const rows = await checkinAllAccounts([
      { accountId: 'a', accountName: 'Alpha' },
      { accountId: 'b', accountName: 'Beta', enterprise: true },
      { accountId: 'c', accountName: 'Gamma' },
    ], deps)
    expect(rows.map(row => row.status)).toEqual(['claimed', 'skipped', 'claimed'])
    // Nothing was asked about b — not even its credential.
    expect(deps.calls.filter(call => call.endsWith(':b'))).toEqual([])
    expect(rows[1]?.message).toContain('enterprise')
  })

  it('does not charge the batch gap for a skipped row', async () => {
    // The gap spaces REQUESTS; a row that issues none must not delay the next.
    let waits = 0
    const deps = { ...runner(), wait: async () => { waits += 1 } }
    await checkinAllAccounts([
      { accountId: 'b', accountName: 'Beta', enterprise: true },
      { accountId: 'a', accountName: 'Alpha' },
      { accountId: 'c', accountName: 'Gamma' },
    ], deps)
    expect(waits).toBe(1)
  })

  it('does NOT send a claim for an account already checked in today', async () => {
    // Idempotence is the point: a second press must not re-claim, and the row
    // must say why rather than reporting a failure.
    const deps = runner({ checked: { b: true } })
    const rows = await checkinAllAccounts(TARGETS, deps)
    expect(rows.map(row => row.status)).toEqual(['claimed', 'already', 'claimed'])
    expect(deps.calls).not.toContain('claim:b')
    expect(deps.calls).toContain('claim:a')
  })

  it('continues the batch when one account fails, reporting it on its row', async () => {
    // One dead account must not hide the other accounts' outcomes.
    const deps = runner({
      credentialFor: credentialsFor(['a', 'c']),
    })
    const rows = await checkinAllAccounts(TARGETS, deps)
    expect(rows.map(row => row.status)).toEqual(['claimed', 'failed', 'claimed'])
    expect(rows[1]?.message).toContain('no stored credential')
    expect(deps.calls).toContain('claim:c')
  })

  it('reports a claim error as that account failed, without aborting', async () => {
    const deps = runner({
      claimDailyCheckin: async (cred: WorkBuddyCredential) => {
        if (cred.uin === 'b') throw new Error('upstream 502')
        return { credit: 60, streakDays: 7 }
      },
    })
    const rows = await checkinAllAccounts(TARGETS, deps)
    expect(rows.map(row => row.status)).toEqual(['claimed', 'failed', 'claimed'])
    expect(rows[1]?.message).toBe('upstream 502')
  })

  it('treats an inactive check-in window as failed, not as already-claimed', async () => {
    const deps = runner({
      fetchCheckinStatus: async (cred: WorkBuddyCredential) => ({
        active: false,
        todayCheckedIn: cred.uin === 'a',
        streakDays: 0,
        dailyCredit: 0,
        todayCredit: 0,
        isStreakDay: false,
        nextStreakDay: 0,
        streakBonusDays: 0,
        streakBonusCredit: 0,
      }),
    })
    const rows = await checkinAllAccounts(TARGETS, deps)
    // "already checked in today" would be a different, false claim when the
    // activity is closed.
    expect(rows.map(row => row.status)).toEqual(['failed', 'failed', 'failed'])
    expect(rows[0]?.message).toContain('not active')
  })

  it('runs strictly in order, one account at a time', async () => {
    const deps = runner()
    await checkinAllAccounts(TARGETS, deps)
    expect(deps.calls).toEqual([
      'status:a', 'claim:a',
      'status:b', 'claim:b',
      'status:c', 'claim:c',
    ])
  })

  it('pauses between accounts but not before the first', async () => {
    const waits: number[] = []
    const deps = { ...runner(), wait: async (ms: number) => { waits.push(ms) } }
    await checkinAllAccounts(TARGETS, deps)
    expect(waits).toEqual([POOL_BATCH_GAP_MS, POOL_BATCH_GAP_MS])
  })

  it('handles an empty pool', async () => {
    expect(await checkinAllAccounts([], runner())).toEqual([])
  })

  it('handles a pool of one', async () => {
    const deps = runner()
    const rows = await checkinAllAccounts([TARGETS[0] as WorkBuddyPoolTarget], deps)
    expect(rows).toHaveLength(1)
    expect(deps.calls).toEqual(['status:a', 'claim:a'])
  })
})

describe('testAllAccounts', () => {
  it('probes every account against the given model', async () => {
    const deps = runner()
    const rows = await testAllAccounts(TARGETS, 'deepseek-v4.1-flash', deps)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.result.outcome === 'ok')).toBe(true)
    expect(deps.calls).toEqual([
      'probe:a:deepseek-v4.1-flash',
      'probe:b:deepseek-v4.1-flash',
      'probe:c:deepseek-v4.1-flash',
    ])
  })

  it('keeps one account failure from aborting the batch', async () => {
    const deps = runner({
      credentialFor: credentialsFor(['a', 'c']),
    })
    const rows = await testAllAccounts(TARGETS, 'm', deps)
    expect(rows.map(row => row.result.outcome))
      .toEqual(['ok', 'credential-rejected', 'ok'])
    expect(deps.calls).toContain('probe:c:m')
  })

  it('records a per-account probe outcome without collapsing the batch', async () => {
    const deps = runner({
      probe: async (cred: WorkBuddyCredential, modelId: string) =>
        cred.uin === 'b'
          ? { modelId, outcome: 'rate-limited', retryAtMs: Date.now() + 60_000 }
          : { modelId, outcome: 'ok' },
    })
    const rows = await testAllAccounts(TARGETS, 'm', deps)
    expect(rows.map(row => row.result.outcome)).toEqual(['ok', 'rate-limited', 'ok'])
  })

  it('never throws when the credential store itself throws', async () => {
    const deps = runner({
      credentialFor: async () => { throw new Error('store exploded') },
    })
    const rows = await testAllAccounts(TARGETS, 'm', deps)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.result.outcome === 'credential-rejected')).toBe(true)
    expect(rows[0]?.result.message).toBe('store exploded')
  })

  it('runs strictly serially', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const deps = runner({
      probe: async (cred: WorkBuddyCredential, modelId: string) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 1))
        inFlight -= 1
        return { modelId, outcome: 'ok' }
      },
    })
    await testAllAccounts(TARGETS, 'm', deps)
    expect(maxInFlight).toBe(1)
  })

  it('handles an empty pool without probing anything', async () => {
    const probe = vi.fn()
    const deps = runner({ probe })
    expect(await testAllAccounts([], 'm', deps)).toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('probeUpdatesOf', () => {
  const row = (accountId: string, result: WorkBuddyProbeResult): WorkBuddyPoolTestRow =>
    ({ accountId, accountName: accountId, result })

  // This writer is one of the TWO sites that record the same account, and they
  // overwrite each other. Its label is what makes a later live failure legible:
  // the record then says the account was deliberately measured, so the change
  // has an explanation on screen instead of looking like the file rolled back.
  it('labels every measured row as a test batch', () => {
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'ok' }),
      row('beta', { modelId: 'm', outcome: 'rate-limited', retryAtMs: 123 }),
    ])
    expect(updates['alpha']?.source).toBe('test-batch')
    expect(updates['beta']?.source).toBe('test-batch')
  })

  it('carries outcome, retry time and message through unchanged', () => {
    // Pinned beside the label so a future edit cannot fix the label by breaking
    // the fields the routing actually reads.
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'rate-limited', retryAtMs: 456, message: 'code 6004' }),
    ])
    expect(updates['alpha']).toMatchObject({
      outcome: 'rate-limited',
      retryAtMs: 456,
      message: 'code 6004',
      source: 'test-batch',
    })
  })

  it('omits a transport failure entirely rather than labelling it', () => {
    // A row rejected before the model was reached says nothing about the
    // account, so it must not be recorded at all — with or without a label.
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'credential-rejected', message: 'no stored credential for uid-x' }),
      row('beta', { modelId: 'm', outcome: 'ok' }),
    ])
    expect(updates['alpha']).toBeUndefined()
    expect(updates['beta']?.source).toBe('test-batch')
  })

  it('stamps one time for the whole batch', () => {
    // The card reads this as "tested N minutes ago"; a per-row timestamp would
    // make the rows of one batch disagree with each other.
    const updates = probeUpdatesOf([
      row('alpha', { modelId: 'm', outcome: 'ok' }),
      row('beta', { modelId: 'm', outcome: 'ok' }),
    ])
    expect(updates['alpha']?.atMs).toBe(updates['beta']?.atMs)
  })
})

describe('travelAllAccounts', () => {
  type TravelDeps = WorkBuddyPoolTravelDeps

  function travelDeps(overrides: Partial<TravelDeps> = {}): TravelDeps & { calls: string[] } {
    // Every call is recorded here, not in the default bodies: a test that
    // replaces one step must still be able to assert the ORDER of the others.
    const calls: string[] = []
    const base = credentialsFor(['a', 'b'])
    return {
      calls,
      credentialFor: overrides.credentialFor ?? base,
      fetchTravelStatus: async (credential) => {
        calls.push('status')
        return overrides.fetchTravelStatus === undefined
          ? { state: 'idle', dailyLimitReached: false }
          : overrides.fetchTravelStatus(credential)
      },
      claimTravelReward: async (credential) => {
        calls.push('claim')
        return overrides.claimTravelReward === undefined
          ? { credit: 8 }
          : overrides.claimTravelReward(credential)
      },
      departBuddy: async (credential, locationId) => {
        calls.push(`depart:${locationId ?? 'random'}`)
        return overrides.departBuddy === undefined
          ? { location: '咖啡馆' }
          : overrides.departBuddy(credential, locationId)
      },
      wait: async () => undefined,
    }
  }

  const TWO: readonly WorkBuddyPoolTarget[] = [
    { accountId: 'a', accountName: 'Alpha' },
    { accountId: 'b', accountName: 'Beta' },
  ]

  it('claims a landed reward BEFORE dispatching, and reports both', async () => {
    // The ordering is the feature: `arrived` blocks a dispatch, so a run that
    // dispatched first would silently skip the reward every time.
    let statusCalls = 0
    const deps = travelDeps({
      fetchTravelStatus: async () => {
        statusCalls += 1
        return { state: statusCalls === 1 ? 'arrived' : 'idle', dailyLimitReached: false }
      },
    })
    const rows = await travelAllAccounts(TWO.slice(0, 1), deps)

    expect(deps.calls).toEqual(['status', 'claim', 'status', 'depart:random'])
    expect(rows[0]).toMatchObject({ status: 'claimed', credit: 8, departed: true, location: '咖啡馆' })
  })

  it('leaves a trip in flight alone', async () => {
    const deps = travelDeps({
      fetchTravelStatus: async () => ({ state: 'traveling', dailyLimitReached: false, arriveAtMs: 1_700_000_000_000 }),
    })
    const rows = await travelAllAccounts(TWO.slice(0, 1), deps)
    expect(rows[0]).toMatchObject({ status: 'traveling', arriveAtMs: 1_700_000_000_000 })
    expect(deps.calls).toEqual(['status'])
  })

  it("never dispatches once the server's daily cap is reached", async () => {
    const deps = travelDeps({
      fetchTravelStatus: async () => ({ state: 'idle', dailyLimitReached: true }),
    })
    const rows = await travelAllAccounts(TWO.slice(0, 1), deps)
    expect(rows[0]?.status).toBe('limit')
    expect(deps.calls).toEqual(['status'])
  })

  it('claims nothing on a read-only run', async () => {
    const deps = travelDeps({
      fetchTravelStatus: async () => ({ state: 'arrived', dailyLimitReached: false, rewardCredit: 8 }),
    })
    const rows = await travelAllAccounts(TWO.slice(0, 1), deps, { readOnly: true })
    expect(rows[0]).toMatchObject({ status: 'arrived', credit: 8 })
    expect(deps.calls).toEqual(['status'])
  })

  it('reports an account without 派猫猫 as skipped, not failed', async () => {
    // `403 no active buddy` is account state; painting it red every run would
    // send the user off to fix their credentials.
    const deps = travelDeps({
      fetchTravelStatus: async () => ({ state: 'arrived', dailyLimitReached: false }),
      claimTravelReward: async () => {
        throw new Error('workbuddy travel: no active buddy')
      },
    })
    const rows = await travelAllAccounts(TWO.slice(0, 1), deps)
    expect(rows[0]?.status).toBe('skipped')
    expect(rows[0]?.message).toContain('no active buddy')
  })

  it('keeps the claim when only the dispatch fails', async () => {
    // The claim already happened upstream; hiding it would hide a real gain.
    let statusCalls = 0
    const deps = travelDeps({
      fetchTravelStatus: async () => {
        statusCalls += 1
        return { state: statusCalls === 1 ? 'arrived' : 'idle', dailyLimitReached: false }
      },
      departBuddy: async () => {
        throw new Error('workbuddy upstream limit (http 429): too many requests')
      },
    })
    const rows = await travelAllAccounts(TWO.slice(0, 1), deps)
    expect(rows[0]).toMatchObject({ status: 'claimed', credit: 8 })
    expect(rows[0]?.message).toContain('dispatch failed')
  })

  it('turns one account failure into a row and keeps going', async () => {
    const deps = travelDeps({
      fetchTravelStatus: async (credential) => {
        if (credential.uin === 'a') throw new Error('boom')
        return { state: 'idle', dailyLimitReached: false }
      },
    })
    const rows = await travelAllAccounts(TWO, deps)
    expect(rows.map(row => row.status)).toEqual(['failed', 'departed'])
  })

  it('picks a destination client-side, because the upstream rejects an empty body', async () => {
    const seen: (number | undefined)[] = []
    const deps = travelDeps({
      departBuddy: async (_credential, locationId) => {
        seen.push(locationId)
        return {}
      },
    })
    await travelAllAccounts(TWO.slice(0, 1), deps)
    await travelAllAccounts(TWO.slice(0, 1), deps, { locationId: 3 })
    // undefined means "the upstream chooses"; the real command fills 1-4 before
    // the call, and an explicit --location must pass straight through.
    expect(seen).toEqual([undefined, 3])
  })
})
