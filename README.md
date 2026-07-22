# commoncall

Serverless peer-to-peer video calls in the browser.

**Live page:** https://concept-collection.github.io/commoncall/

Visit the page, enter an ID, and you'll see the IDs of everyone else currently
on the page. Click a visitor to request a call; once they accept — both users
must agree — a direct WebRTC connection is established and audio/video flows
peer-to-peer. During a call you can share your screen in place of your camera.

## How it works

There is no backend. The techniques are the same as the sibling project
[commonview](https://github.com/concept-collection/commonview):

- **Identity** — each browser generates a secp256k1 (BIP340 schnorr) keypair,
  persisted in localStorage. The x-only public key is the peer ID, and every
  message is signed with it, so peers can't be impersonated.
- **Presence & signaling over nostr** — a minimal nostr client (modeled on
  trystero's nostr strategy) publishes ephemeral events to a handful of public
  relays. Everyone announces `{peerId, name, busy}` on a shared root topic
  every few seconds; entries expire when announcements stop. Call requests,
  accept/decline, and WebRTC offer/answer/ICE messages are delivered on a
  per-peer topic derived from the recipient's ID.
- **Mutual consent** — clicking "Call" only publishes a `call-request`. Neither
  side touches the camera or opens a WebRTC connection until the callee
  explicitly accepts.
- **WebRTC media** — after acceptance, the peer with the smaller ID creates the
  offer (deterministic initiator, no glare handling needed). Audio and video
  tracks flow directly between the browsers, with public STUN servers and a
  free TURN relay as fallback for hard NATs.

## Development

```sh
npm install
npm run dev
```

Open the page in two browsers (or one normal + one private window — identity is
per-browser-profile) and call yourself.

`npm run build` type-checks and bundles to `dist/`. Pushes to `main` deploy to
GitHub Pages via `.github/workflows/deploy.yml`.
