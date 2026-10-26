# Zepper Sync

Zepper Sync keeps your spaces, Essentials, pinned tabs and folders the same on your computer and
your iPhone, and lets each device see the tabs the others have open (and send a tab to another).
Each device keeps its own sign-ins, history and passwords.

There's no account. Devices that sync share a secret, the **sync code**; the server only ever holds
what the devices encrypted with it.

The format is version 1. It's implemented, byte for byte the same, in:

- desktop: `src/shared/sync-protocol.ts` (with `src/main/sync.ts` and `src/main/sync-model.ts`);
- iPhone: `src/sync/protocol.ts` (with `src/sync/engine.ts` and `src/sync/merge.ts`).

Both test suites check the same vectors (`test/sync-vectors.json`, `src/sync/vectors.json`). They
talk to the server with the same client (`src/shared/sync-relay.ts`, `src/sync/relay.ts`), and the
server is in `sync-server/`.

## Pairing

The first device makes a 32-byte random secret. Another device joins by scanning it as a QR code
(`zepper://sync#CODE`, which the iPhone's Camera app opens in Zepper) or by typing it: 52 characters
of Crockford base32 in groups of four (`8JGB-F854-…`; I, L and O read as 1, 1 and 0).

Anyone with the code can read and change the chain, as with Brave Sync. A device that leaves stops
syncing and deletes its device record, but still knows the code: to shut a lost device out, start a
new chain and pair the others again.

## Keys

From the secret, with HKDF-SHA256 and the salt `zepper-sync-v1`:

| info      | length | used for                                             |
| --------- | ------ | ---------------------------------------------------- |
| `chain`   | 16     | the chain id (base64url), where the records live     |
| `access`  | 32     | the access token (base64url), which gets a device in |
| `encrypt` | 32     | the XChaCha20-Poly1305 key records are sealed with   |
| `name`    | 32     | the HMAC-SHA256 key for document ids                 |

## Storage

A server that keeps each chain's records, encrypted, and passes changes between its devices, as
Brave Sync's server does: a Cloudflare Worker, with a Durable Object for each chain (named by its
id) holding the records in SQLite (`sync-server/src/index.ts`). It's at
`wss://sync.zepper.workers.dev`; `npm run dev` in `sync-server/` runs one locally
(`ZEPPER_SYNC_SERVER=ws://127.0.0.1:8787` points the desktop app at it,
`EXPO_PUBLIC_SYNC_SERVER` the iPhone app).

- A record is a document `{ doc, c, t }`. `doc` is base64url of the first 16 bytes of
  HMAC(`name`, `"{type}/{id}"`): every device computes the same id for the same thing, and the server
  can't tell what it is. `c` is base64url of a 24-byte random nonce followed by the ciphertext and
  tag of the record's JSON, sealed with the document id as associated data (a record copied into
  another document doesn't open). `t` is the server's write time (ms), always moving forward.
- A deleted record keeps its document with `c: null` for 30 days, so devices that were away hear of
  it, and the server then removes it. A sent tab, once opened, and a device that leaves are removed
  straight away.

A device connects to `/v1/chains/{chainId}` over a WebSocket, and messages are JSON:

| from   | message                                 | what it does                                                |
| ------ | --------------------------------------- | ----------------------------------------------------------- |
| device | `{ op: 'hello', v: 1, token }`          | first, with the access token                                |
| server | `{ op: 'records', records, done }`      | the whole chain, in parts, then `done: true`                |
| server | `{ op: 'changes', records?, removed? }` | each change as it's made, the device's own included         |
| device | `{ op: 'put', id, docs: [{ doc, c }] }` | writes (or deletes, with `c: null`); the server sets `t`    |
| device | `{ op: 'remove', id, docs: [doc] }`     | removes documents for good                                  |
| server | `{ op: 'ack', id }`                     | the server has a put or remove                              |
| server | `{ op: 'error', message }`              | refused (a wrong code, a malformed message), then it closes |
| device | `ping`                                  | the server answers `pong`, so a lost connection is noticed  |

The first device to say hello sets the chain's token: the server keeps only its SHA-256, and from
then on lets in only devices with the same one, so knowing a chain's id isn't enough to read or
change it. Chains can't be listed or searched.

The client keeps the chain as the server has it and reports what changed (the whole chain the first
time), sends writes made while offline once it's back, and reconnects by itself; each time it does,
the chain comes in again and only what differs is reported.

## Records

```ts
{ type: 'space', id, name, icon, theme: { colors, opacity, texture, scheme? }, order }
{ type: 'pin', id, spaceId, zone: 'essential' | 'pinned', parentId, order, url, title }
{ type: 'folder', id, spaceId, parentId, order, name }
{ type: 'device', id, name, platform: 'ios' | 'mac' | 'linux' | 'windows', seenAt, tabs: [{ url, title, spaceId }] }
{ type: 'send', id, to, from, url, title, at }
```

- Ids are the apps' own (UUIDs): a pinned tab's id on the desktop is its pin's id everywhere.
- `order` is a [fractional index](https://github.com/rocicorp/fractional-indexing): an item's place
  among its siblings (spaces; a space's Essentials; a space's or folder's pinned tabs and folders,
  which share one list). Moving an item changes only its own key.
- A device record is written only by its device: its name and up to 60 open tabs.
- A send record is a tab for the device `to`, which opens it and deletes the record.

## Merging

Each record is its own document, so changes to different things never collide; for the same thing,
the last write wins. A device applies what comes in (keeping its own details: whether a folder is
collapsed, a page's icon, which pinned tabs are open) and sends what it changed, comparing with what
the server has so that applying a change never sends it back.

When two devices give items the same key (both created a first space), the order is settled by id
and the next write gives one of them a key of its own.

A phone that hasn't been used yet, joining a chain that has spaces, takes the chain's spaces instead
of adding its own empty "Personal". Otherwise joining merges: nothing on either side is dropped.

## Versions

A record a device can't open (a newer format, or not this chain's) is left alone. Newer versions
must keep reading version 1 records and keep their fields; new fields are ignored by older apps.
