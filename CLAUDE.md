# CLAUDE.md

Tips for future agents working in this repo. It borrows the p2p techniques of
the sibling project `commonview` — read that first; this file only covers what
is different here.

## Architecture

```
src/p2p/
  identity.ts  schnorr keypair; pubkey hex = peer ID  — ported from commonview
  nostr.ts     minimal relay client + topic scheme    — ported (adds event-id dedup)
  peer.ts      WebRTC wrapper: media tracks + a control data channel
  network.ts   the heart: presence roster + the call state machine
src/App.tsx    join form, roster, ring/accept UI, video views
```

## Key design decisions

- **No auto-connect.** Unlike commonview (which meshes every peer), WebRTC is
  only brought up after an explicit `call-request` → `call-accept` handshake;
  `getUserMedia` is also deferred until then. All pre-call messaging rides on
  nostr per-peer topics.
- **One call at a time.** A second incoming ring is auto-declined with
  `busy: true`. Glare (both users call each other) is treated as mutual
  acceptance.
- **Ephemeral events need retries.** The caller re-publishes its ring every 4 s
  (the `Nostr` class dedupes by event id on the receiving side); a callee in
  `connecting` answers a re-ring by re-sending `call-accept`. Ring and connect
  phases both time out at 45 s.
- **Deterministic initiator.** The smaller peer ID creates the offer, same as
  commonview — no perfect-negotiation glare handling. Both sides add their
  tracks before signaling starts so one offer/answer round covers all media.

## Testing

`npm run dev`, then open two browsers (identity is per-browser-profile via
localStorage, so two tabs in one profile are the SAME peer — use a private
window or second browser). `npm run build` type-checks (`tsc -b`) and bundles.
