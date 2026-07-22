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
  settings.ts  shared per-call settings: types, quality presets, validators
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
- **Screen share = track swap.** `getDisplayMedia` + `RTCRtpSender.replaceTrack`
  replaces the camera track in place (screen instead of camera, not alongside).
  Same-kind replacement avoids renegotiation, which the one-offer design cannot
  do — never addTrack mid-call.
- **Shared call settings ride the control channel.** One settings object per
  call (reset each call), editable by either side; sync is per-key
  last-writer-wins via `{t:'set', key, value, rev}` — a same-rev tie resolves
  to the smaller peer ID's value on both sides. The video-quality presets map
  to `RTCRtpSender.setParameters` caps (maxBitrate / scaleResolutionDownBy /
  maxFramerate), which each side applies to its OWN sender — live, no
  renegotiation. While screen sharing, resolution downscaling is skipped
  (downscaled text is unreadable) and degradationPreference is
  maintain-resolution; caps are re-derived on every share start/stop.
- **Mute is per-party, NOT a shared setting.** Each side owns its own flags —
  no revision counters, the ordered control channel makes last-sent win.
  Toggling `track.enabled` sends silence/black without renegotiation; the
  other side is told via `{t:'mute', audio, video}` and shows badges. The
  notice carries the EFFECTIVE outgoing video state: while screen sharing the
  screen is always live, so a muted camera is latent until the share ends
  (share start/stop re-sends the notice).

## Testing

`npm run dev`, then open two browsers (identity is per-browser-profile via
localStorage, so two tabs in one profile are the SAME peer — use a private
window or second browser). `npm run build` type-checks (`tsc -b`) and bundles.
