// @vitest-environment jsdom
/**
 * The upstream-identity switches in the card (issue #133 suggestions 2 and 3).
 *
 * These four settings existed only in `cordis.patch.yml` until now: a user who
 * wanted the usage page to say "WorkBuddy" had to hand-edit a YAML file inside
 * their profile and know that the plugin must be reloaded afterwards. The
 * request was explicitly "put them in the settings page so users can tick them".
 *
 * What is worth pinning, and why:
 *
 * 1. Each switch renders with the COMMITTED value — an absent field reads OFF.
 *    These authorize a change in what the gateway sees and what gets billed, so
 *    a missing value must never be displayed as if it were on.
 * 2. Flipping one writes THAT field only, on its own path. The switches are
 *    independent top-level config fields, and the failure they could have — a
 *    write that clobbers a sibling — is invisible in the UI but destroys a
 *    setting the user set earlier.
 * 3. `sessionTitle` writes the whole object, preserving the target model. Its
 *    field is an object (`{enabled, model}`), so a naive boolean write would
 *    erase `model` and silently move the title request back to `wb-lite`'s
 *    default after a user had pointed it somewhere else.
 * 4. The "reload the plugin" caveat is on screen. All four are sampled when the
 *    plugin mounts into the shim; a user who flips one and sees no change has no
 *    way to learn that from the control itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { extraInjectedPrefixesOf, sessionTitleOf, upstreamSwitchOf } from '../src/client/account-selection.ts'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** A signed-in usage body. */
function usage(): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'cn One' }],
    models: [{ id: 'model-a', name: 'Model A' }],
    enabledModelIds: ['model-a'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
  }
}

/**
 * The switch inputs, labelled by their copy text.
 *
 * Read from `.dsm-workbuddy-upstream-check` so the picker row (a label with no
 * per-region credit switches (which own `.dsm-workbuddy-pref-check`) cannot be
 * mistaken for these — and from the row's own
 * `.dsm-workbuddy-pref-label` so the hint text does not end up in the label.
 */
function switches(container: HTMLElement): { label: string, checked: boolean, disabled: boolean }[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-workbuddy-upstream-check'))
    .map(input => ({
      label: input.closest('.dsm-workbuddy-pref')?.querySelector('.dsm-workbuddy-pref-label')?.textContent ?? '',
      checked: input.checked,
      disabled: input.disabled,
    }))
}

/** The input whose row copy starts with the given locale key's text. */
function switchFor(container: HTMLElement, labelKey: string): HTMLInputElement {
  const wanted = t(labelKey)
  const found = Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-workbuddy-upstream-check'))
    .find(input => (input.closest('.dsm-workbuddy-pref')
      ?.querySelector('.dsm-workbuddy-pref-label')?.textContent ?? '') === wanted)
  if (found === undefined) throw new Error(`no switch labelled ${String(wanted)}`)
  return found
}

const render = async (scopeValue: Record<string, unknown>) => {
  const calls = stubFetch((url, init) => {
    if (!url.includes('__save')) return { body: usage() }
    // Answer the way the Host does: `{ ok, value: { [field]: committed } }`.
    // Echoing the posted field back matters — the card mirrors what it is
    // handed, so a stub that answers `{}` would make every write look lost.
    const posted = JSON.parse(String(init?.body ?? '{}')) as { field?: string, value?: unknown }
    return { body: { ok: true, value: posted.field === undefined ? {} : { [posted.field]: posted.value } } }
  })
  const scope = fakeScope(scopeValue)
  const m = await mount(WorkBuddyCard, { t, settingsScope: scope, view: 'page' })
  await m.settle()
  return { m, scope, calls }
}

describe('the upstream-identity switches', () => {
  it('renders all three with their committed values', async () => {
    const { m } = await render({
      usageIdentity: true,
      keepPromptLast: false,
      sessionTitle: { enabled: true, model: 'wb-lite' },
    })
    expect(switchFor(m.container, 'row.usageIdentityLabel').checked).toBe(true)
    expect(switchFor(m.container, 'row.keepPromptLastLabel').checked).toBe(false)
    expect(switchFor(m.container, 'row.sessionTitleLabel').checked).toBe(true)
  })

  it('reads an absent setting as OFF, never as on', async () => {
    // The switches change what is billed and what the gateway sees; a missing
    // field must not be displayed as consent.
    const { m } = await render({})
    expect(switchFor(m.container, 'row.usageIdentityLabel').checked).toBe(false)
    expect(switchFor(m.container, 'row.keepPromptLastLabel').checked).toBe(false)
    expect(switchFor(m.container, 'row.sessionTitleLabel').checked).toBe(false)
  })

  it('writes only the field that was flipped, on its own path', async () => {
    const { m, scope } = await render({})
    await m.click(switchFor(m.container, 'row.usageIdentityLabel'))
    await m.settle()
    // The settings scope received exactly one write, for this field alone.
    expect(scope.writes.map((w: { field: string }) => w.field)).toEqual(['usageIdentity'])
    expect(scope.writes[0].value).toBe(true)
    // And it did NOT arrive as a block of siblings.
    expect(scope.writes[0].value).not.toBeTypeOf('object')
  })

  it('preserves the sessionTitle model when only the switch is flipped', async () => {
    // The field is an object; a boolean write would erase `model`.
    const { m, scope } = await render({ sessionTitle: { enabled: false, model: 'wb-lite-custom' } })
    await m.click(switchFor(m.container, 'row.sessionTitleLabel'))
    await m.settle()
    expect(scope.writes.map((w: { field: string }) => w.field)).toEqual(['sessionTitle'])
    expect(scope.writes[0].value).toEqual({ enabled: true, model: 'wb-lite-custom' })
  })

  it('posts the field name to the Host save endpoint, so the Host keeps the truth', async () => {
    const { m, calls } = await render({})
    await m.click(switchFor(m.container, 'row.keepPromptLastLabel'))
    await m.settle()
    const saves = calls.filter(call => call.url.includes('__save'))
    expect(saves).toHaveLength(1)
    const save = saves[0]
    if (save === undefined) throw new Error('no __save call was made')
    const body = JSON.parse(save.init.body) as { field: string, value: unknown }
    expect(body.field).toBe('keepPromptLast')
    expect(body.value).toBe(true)
  })

  it('tells the user that a reload is needed for the change to take effect', async () => {
    // All four are sampled when the plugin mounts into the shim. Without this
    // line a user flips a switch, sees nothing, and concludes it is broken.
    const { m } = await render({})
    expect(m.container.textContent).toContain(t('row.upstreamHint'))
  })
})

/**
 * The readers, tested directly.
 *
 * They are the boundary between a hand-edited YAML file and the card, so the
 * malformed-value cases matter more than the happy path: a wrong reading here
 * shows a switch in the wrong position, or worse, feeds a bad value onward.
 */
describe('reading the upstream switches out of a settings snapshot', () => {
  it('accepts only an explicit true, and unwraps a volatile reference', () => {
    expect(upstreamSwitchOf({ usageIdentity: true }, 'usageIdentity')).toBe(true)
    expect(upstreamSwitchOf({ usageIdentity: false }, 'usageIdentity')).toBe(false)
    // Garbage is OFF, not "truthy".
    expect(upstreamSwitchOf({ usageIdentity: 'true' }, 'usageIdentity')).toBe(false)
    expect(upstreamSwitchOf({ usageIdentity: 1 }, 'usageIdentity')).toBe(false)
    expect(upstreamSwitchOf({}, 'usageIdentity')).toBe(false)
    expect(upstreamSwitchOf(undefined, 'usageIdentity')).toBe(false)
    // The settings service hands volatile fields back as `{get(): T}`.
    expect(upstreamSwitchOf({ usageIdentity: { get: () => true } }, 'usageIdentity')).toBe(true)
  })

  it('falls back to the schema defaults for sessionTitle', () => {
    expect(sessionTitleOf({})).toEqual({ enabled: false, model: 'wb-lite' })
    expect(sessionTitleOf({ sessionTitle: { enabled: true } })).toEqual({ enabled: true, model: 'wb-lite' })
    expect(sessionTitleOf({ sessionTitle: { enabled: true, model: 'x' } })).toEqual({ enabled: true, model: 'x' })
    // A malformed block must not fabricate an enabled switch.
    expect(sessionTitleOf({ sessionTitle: 'yes' })).toEqual({ enabled: false, model: 'wb-lite' })
    expect(sessionTitleOf({ sessionTitle: { enabled: 'yes', model: 5 } })).toEqual({ enabled: false, model: 'wb-lite' })
    // Blank model reads as the default rather than as an empty target.
    expect(sessionTitleOf({ sessionTitle: { enabled: true, model: '   ' } })).toEqual({ enabled: true, model: 'wb-lite' })
  })

  it('reads the extra prefix list defensively', () => {
    expect(extraInjectedPrefixesOf({ extraInjectedPrefixes: ['a', 'b'] })).toEqual(['a', 'b'])
    // Trimmed, deduplicated, blanks dropped, non-strings ignored.
    expect(extraInjectedPrefixesOf({ extraInjectedPrefixes: [' a ', 'a', '', '  ', 'b', 5, null] })).toEqual(['a', 'b'])
    // Anything that is not a list reads as empty, so garbage cannot start
    // matching messages it was never meant to match.
    expect(extraInjectedPrefixesOf({ extraInjectedPrefixes: 'a' })).toEqual([])
    expect(extraInjectedPrefixesOf({})).toEqual([])
  })
})
