// @vitest-environment jsdom
/**
 * The media roster INSIDE the card's Capabilities tab.
 *
 * The roster is the answer to "can this tab draw at all, and with what" — it
 * exists because the draw tool's model is chosen from here and because a
 * pre-5.8.0 card gave no hint whether the international tab could draw at all.
 *
 * The cases pin the four things that go wrong with a block like this:
 *   1. it is read at all, ONCE per region, and only when the panel is opened;
 *   2. a row renders what the tool would actually send (`id`) next to a name
 *      a human can read, with the tag translated;
 *   3. an EMPTY roster (a gateway that publishes none) reads as a sentence,
 *      not as a failure — and a FAILURE stays inside the block rather than
 *      replacing the panel;
 *   4. a half-shaped row is dropped instead of throwing, because a read-only
 *      list must never take the card down.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const MEDIA_PATH = '/plugins/dsh-connect-workbuddy/media-models'

function usageOf(region: string): Record<string, unknown> {
  return {
    status: 'signed-in',
    region,
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: `${region}-1`, accountName: `${region} One` }],
    models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    enabledModelIds: ['glm-5.3'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
  }
}

/**
 * Mount the card with the Capabilities tab open.
 *
 * `roster` answers the media route; everything else gets the usage body. The
 * region tab is clicked FIRST because the card remembers the last region tab
 * used in earlier cases and only renders the section tabs for a signed-in
 * region — landing on the international tab would leave this fixture signed
 * out with no tab bar at all.
 */
async function renderCapabilities(
  roster: (url: string) => { status?: number, body: unknown },
): Promise<{ container: HTMLElement, calls: { url: string, init: any }[], m: any }> {
  const calls = stubFetch(url => ({
    ...url.includes(MEDIA_PATH) ? roster(url) : { body: usageOf('cn') },
  }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({ regions: { cn: {} } }), view: 'page' })
  await m.settle()
  const cnTab = m.container.querySelectorAll('.dsm-workbuddy-tab')[0]
  if (cnTab !== undefined && !cnTab.classList.contains('dsm-workbuddy-tab-active')) {
    await m.click(cnTab)
  }
  const capabilities = m.container.querySelector<HTMLElement>('[id="dsm-workbuddy-tab-capabilities"]')
  if (capabilities === null) throw new Error('capabilities tab missing')
  await m.click(capabilities)
  await m.settle()
  return { container: m.container as HTMLElement, calls, m }
}

const mediaCalls = <T extends { url: string }>(calls: T[]): T[] =>
  calls.filter(call => call.url.includes(MEDIA_PATH))

const rows = (container: HTMLElement): Element[] =>
  Array.from(container.querySelectorAll('.dsm-workbuddy-media-row'))

describe('the media roster in the Capabilities tab', () => {
  it('reads the roster once for the active region, and not before the panel is opened', async () => {
    // Eager would be wrong: the usage fetch already runs for BOTH regions on
    // open, so reading the roster for a region nobody is looking at would spend
    // a request the user did not ask for.
    const { calls } = await renderCapabilities(() => ({
      body: { models: [{ id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] }] },
    }))
    const seen = mediaCalls(calls)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toContain('region=cn')
    // The explicit button is the ONLY thing that adds `refresh=1`.
    expect(seen[0]?.url).not.toContain('refresh=1')
  })

  it('renders each model as a name, the id the tool would send, and a translated tag', async () => {
    const { container } = await renderCapabilities(() => ({
      body: {
        models: [
          { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] },
          { id: 'hunyuan-image-alpha-edit', name: 'Edit', tags: ['image-to-image'] },
        ],
      },
    }))
    const rendered = rows(container)
    expect(rendered).toHaveLength(2)
    expect(rendered[0]?.querySelector('.dsm-workbuddy-media-name')?.textContent).toBe('Hunyuan Image Alpha')
    // The ID is shown verbatim: it is what the user has to pass to the tool.
    expect(rendered[0]?.querySelector('.dsm-workbuddy-media-id')?.textContent).toBe('hunyuan-image-alpha')
    // The tag goes through the copy table, not the raw upstream string.
    expect(rendered[1]?.querySelector('.dsm-workbuddy-media-tag')?.textContent).toBe('row.mediaTagImageToImage')
  })

  it('treats an empty roster as a sentence, not as an error', async () => {
    const { container } = await renderCapabilities(() => ({ body: { models: [] } }))
    expect(rows(container)).toHaveLength(0)
    expect(container.querySelector('.dsm-workbuddy-media-empty')).not.toBeNull()
    expect(container.querySelector('.dsm-workbuddy-media-error')).toBeNull()
  })

  it('keeps a failed read inside the block, leaving the rest of the panel usable', async () => {
    // One unreachable roster must not replace the whole panel with an error
    // screen: the credit and image-tool switches are unrelated to it.
    const { container } = await renderCapabilities(() => ({ status: 500, body: { error: 'config read failed' } }))
    expect(container.querySelector('.dsm-workbuddy-media-error')?.textContent)
      .toBe('row.mediaModelsError|message=HTTP 500')
    expect(container.querySelector('.dsm-workbuddy-pref-check')).not.toBeNull()
  })

  it('drops a half-shaped row instead of throwing', async () => {
    // A read-only list is not worth an exception: an entry without a string id
    // is unrenderable and unaddressable, so it is skipped.
    const { container } = await renderCapabilities(() => ({
      body: {
        models: [
          { id: 'ok-model', name: 'OK', tags: ['text-to-image'] },
          { name: 'no id' },
          { id: 42, name: 'wrong type' },
        ],
      },
    }))
    const rendered = rows(container)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]?.querySelector('.dsm-workbuddy-media-id')?.textContent).toBe('ok-model')
  })

  it('asks the Host to bypass its cache only when the button is pressed', async () => {
    const { container, calls, m } = await renderCapabilities(() => ({
      body: { models: [{ id: 'a', name: 'A', tags: [] }] },
    }))
    const button = Array.from(container.querySelectorAll('button'))
      .find(node => (node.textContent ?? '').includes('row.mediaModelsRefresh'))
    if (button === undefined) throw new Error('the re-read button is missing')
    await m.click(button)
    await m.settle()
    const seen = mediaCalls(calls)
    expect(seen).toHaveLength(2)
    expect(seen[1]?.url).toContain('refresh=1')
    expect(seen[1]?.init?.method).toBe('POST')
  })
})
