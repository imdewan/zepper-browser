// The server, through the apps' own client (src/shared/sync-relay.ts), running locally:
// npm run dev in one terminal, npm test in another (ZEPPER_SYNC_SERVER to test another one).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { Relay } from '../../src/shared/sync-relay.ts'

const SERVER = process.env.ZEPPER_SYNC_SERVER ?? 'ws://127.0.0.1:8787'
const id = (n) => randomBytes(n).toString('base64url')

/** A device on a chain, with what it's heard. */
function device(chain, token) {
  const seen = []
  const statuses = []
  let wake = null
  const relay = new Relay(`${SERVER}/v1/chains/${chain}`, token, {
    changes: (changes) => {
      seen.push(...changes)
      wake?.()
    },
    status: (status) => {
      statuses.push(status)
      wake?.()
    }
  })
  /** Waits until a test holds of what it's heard. */
  const until = async (check, ms = 5000) => {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out; heard ${JSON.stringify(seen)} ${JSON.stringify(statuses)}`)
      await new Promise((resolve) => {
        wake = resolve
        setTimeout(resolve, 50)
      })
    }
  }
  return { relay, seen, statuses, until }
}

test('devices on a chain hear each other, theirs included, and a newcomer gets it all', async () => {
  const chain = id(16)
  const token = id(32)
  const a = device(chain, token)
  const b = device(chain, token)
  a.relay.start()
  b.relay.start()
  await a.until(() => a.statuses.some((s) => s.kind === 'connected'))
  await b.until(() => b.statuses.some((s) => s.kind === 'connected'))
  const doc = id(16)
  await a.relay.put([{ doc, c: 'sealed1' }])
  await b.until(() => b.seen.some((c) => c.doc === doc && c.type === 'added' && c.data.c === 'sealed1'))
  await a.until(() => a.seen.some((c) => c.doc === doc))
  await b.relay.put([{ doc, c: null }])
  await a.until(() => a.seen.some((c) => c.doc === doc && c.type === 'modified' && c.data.c === null))

  const c = device(chain, token)
  c.relay.start()
  await c.until(() => c.statuses.some((s) => s.kind === 'connected'))
  assert.deepEqual(
    c.seen.map((x) => [x.type, x.doc, x.data.c]),
    [['added', doc, null]]
  )
  assert.ok(c.seen[0].data.t > 0)
  for (const d of [a, b, c]) d.relay.close()
})

test('a device without the chain’s code is refused', async () => {
  const chain = id(16)
  const owner = device(chain, id(32))
  owner.relay.start()
  await owner.until(() => owner.statuses.some((s) => s.kind === 'connected'))
  const stranger = device(chain, id(32))
  stranger.relay.start()
  await stranger.until(() => stranger.statuses.some((s) => s.kind === 'error'))
  assert.match(stranger.statuses.find((s) => s.kind === 'error').message, /code/)
  owner.relay.close()
  stranger.relay.close()
})

test('removed for good, and a device that was away hears of what it missed', async () => {
  const chain = id(16)
  const token = id(32)
  const a = device(chain, token)
  a.relay.start()
  await a.until(() => a.statuses.some((s) => s.kind === 'connected'))
  const kept = id(16)
  const gone = id(16)
  await a.relay.put([
    { doc: kept, c: 'k1' },
    { doc: gone, c: 'g1' }
  ])
  const b = device(chain, token)
  b.relay.start()
  await b.until(() => b.seen.length === 2)
  b.relay.close()

  // While b is away: one goes, one changes.
  await a.relay.remove([gone])
  await a.relay.put([{ doc: kept, c: 'k2' }])
  await a.until(() => a.seen.some((c) => c.doc === gone && c.type === 'removed'))

  b.seen.length = 0
  b.relay.start()
  await b.until(() => b.seen.length === 2)
  assert.deepEqual(
    b.seen.map((x) => [x.type, x.doc, x.data.c]).sort(),
    [
      ['modified', kept, 'k2'],
      ['removed', gone, 'g1']
    ].sort()
  )
  a.relay.close()
  b.relay.close()
})

test('writes made before connecting go out once connected', async () => {
  const chain = id(16)
  const token = id(32)
  const a = device(chain, token)
  const doc = id(16)
  const written = a.relay.put([{ doc, c: 'early' }])
  a.relay.start()
  await written
  await a.until(() => a.seen.some((c) => c.doc === doc && c.data.c === 'early'))
  a.relay.close()
})

test('the server refuses what isn’t a chain or a record', async () => {
  const response = await fetch(`${SERVER.replace(/^ws/, 'http')}/v1/chains/not-a-chain`)
  assert.equal(response.status, 400)
  const chain = id(16)
  const a = device(chain, id(32))
  a.relay.start()
  await a.until(() => a.statuses.some((s) => s.kind === 'connected'))
  void a.relay.put([{ doc: 'nope', c: 'x' }])
  await a.until(() => a.statuses.some((s) => s.kind === 'error'))
  a.relay.close()
})
