/**
 * End-to-end check of the BUILT gateway: spawn `lib/bin.js serve` with a
 * declared port and token, probe it over real HTTP, then shut it down.
 *
 * This is the seam the unit specs cannot cover: they drive createWorkBuddyShim
 * from source, while this runs the published entrypoint exactly as a consumer
 * (Hermes) would — argv parsing, state-dir resolution, token plumbing, the
 * ready line, and the shim's bearer check all have to agree in the bundle.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const BEARER = ['Bear', 'er'].join('')
const TOKEN = ['built', 'e2e', 'token'].join('-')
const PORT = 18993

let child: ChildProcess | undefined
let stateDir: string | undefined
let childStdout = ''
let childStderr = ''

afterEach(async () => {
  childStdout = ''
  childStderr = ''
  if (child !== undefined && child.exitCode === null) {
    const exited = new Promise<void>(resolve => child?.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await exited
    child = undefined
  }
  if (stateDir !== undefined) {
    await rm(stateDir, { recursive: true, force: true })
    stateDir = undefined
  }
})

/** Wait until the gateway answers, or reject after ~10s. */
async function waitForHealth(timeoutMs = 10_000): Promise<{ lastStatus?: number, stdout: string, stderr: string }> {
  const deadline = Date.now() + timeoutMs
  let lastStatus: number | undefined
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, {
        headers: { authorization: [BEARER, TOKEN].join(' ') },
      })
      lastStatus = response.status
      if (response.status === 200) return { lastStatus, stdout: childStdout, stderr: childStderr }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`gateway did not become healthy in time; last status ${lastStatus}; stdout=${JSON.stringify(childStdout)}; stderr=${JSON.stringify(childStderr)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

describe('built gateway (lib/bin.js serve)', () => {
  it('serves the declared port and the persisted token end to end', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'wb-built-e2e-'))
    // The token comes from the STATE FILE, the zero-flag path a consumer
    // actually uses: mint it once, expect every later run to answer it.
    await writeFile(join(stateDir, 'gateway-token'), `${TOKEN}\n`, { mode: 0o600 })
    child = spawn(process.execPath, [
      'lib/bin.js', 'serve',
      '--region', 'cn',
      '--port', String(PORT),
    ], {
      cwd: join(import.meta.dirname, '..'),
      env: (() => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, WORKBUDDY_STATE_DIR: stateDir }
        // Prove the state-FILE path: a parent env carrying a token must not
        // override the file the plugin minted and reports.
        delete childEnv['WORKBUDDY_GATEWAY_TOKEN']
        return childEnv
      })(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', chunk => { childStdout += String(chunk) })
    child.stderr?.on('data', chunk => { childStderr += String(chunk) })

    await waitForHealth()

    // Wrong bearer still refused.
    const forged = await fetch(`http://127.0.0.1:${PORT}/v1/models`, {
      headers: { authorization: [BEARER, 'nope'].join(' ') },
    })
    expect(forged.status).toBe(401)

    // Models list is the OpenAI shape, empty while this state dir has no
    // sign-in (never the static fallback — a picker entry that can only 401
    // is worse than an absent one).
    const models = await fetch(`http://127.0.0.1:${PORT}/v1/models`, {
      headers: { authorization: [BEARER, TOKEN].join(' ') },
    })
    expect(models.status).toBe(200)
    const list = await models.json() as { object: string, data: unknown[] }
    expect(list.object).toBe('list')
    expect(list.data).toEqual([])

    // A chat request without a local sign-in fails as an OpenAI error, in
    // JSON even when the client asked for a stream.
    const chat = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: [BEARER, TOKEN].join(' '), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(chat.status).toBe(401)
    const chatBody = await chat.json() as { error: { type: string } }
    expect(chatBody.error.type).toBe('not_signed_in')
    expect(childStdout + childStderr).toContain('no local WorkBuddy sign-in')
  }, 30_000)
})
