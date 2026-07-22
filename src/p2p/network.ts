import {selfId} from './identity'
import {Nostr, peerTopic, rootTopic} from './nostr'
import {Peer, type Signal} from './peer'

// ---------------------------------------------------------------------------
// CommonCall network layer.
//
// Presence: everyone who has entered an ID announces {peerId, name, busy} on
// the root topic every few seconds; entries expire when announcements stop.
//
// Calls: clicking a peer publishes a call-request on that peer's personal
// topic. The callee must explicitly accept (call-accept) before either side
// touches getUserMedia or WebRTC — both users must agree. After acceptance the
// two sides exchange offer/answer/ICE via {t:'signal'} messages on the same
// per-peer topics, exactly the technique used by commonview, and the media
// flows peer-to-peer.
//
// Messages are authenticated by the nostr layer: every event is schnorr-signed
// and the sender's pubkey IS the peer ID, so `from` cannot be spoofed.
// ---------------------------------------------------------------------------

interface Announcement {
  peerId: string
  name: string
  busy: boolean
}

type PeerMsg =
  | {t: 'call-request'; name: string}
  | {t: 'call-accept'; name: string}
  | {t: 'call-decline'; busy?: boolean}
  | {t: 'call-cancel'}
  | {t: 'hang-up'}
  | {t: 'signal'; signal: Signal}

const ROOM_ID = 'default'
const ANNOUNCE_INTERVAL_MS = 5000
const PRESENCE_TTL_MS = 15000
// Nostr events are ephemeral and relays are flaky, so re-publish the ring
// while it's pending; the event-id dedup on the far side absorbs repeats.
const RING_RESEND_MS = 4000
const RING_TIMEOUT_MS = 45000
const CONNECT_TIMEOUT_MS = 45000

const NAME_KEY = 'commoncall:name'

export type CallPhase = 'outgoing' | 'incoming' | 'connecting' | 'connected'

interface Call {
  phase: CallPhase
  peerId: string
  peerName: string
  peer: Peer | null
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  /** Signals that arrived before our getUserMedia resolved. */
  pendingSignals: Signal[]
  ringInterval: number | null
  ringTimeout: number | null
  connectTimeout: number | null
}

export interface RosterEntry {
  peerId: string
  name: string
  busy: boolean
}

export interface CallInfo {
  phase: CallPhase
  peerId: string
  peerName: string
  localStream: MediaStream | null
  remoteStream: MediaStream | null
}

export interface Snapshot {
  selfId: string
  name: string | null
  roster: RosterEntry[]
  call: CallInfo | null
  notice: string | null
}

export class Network {
  private nostr = new Nostr()
  private rootReady: Promise<string>
  private presence = new Map<
    string,
    {name: string; busy: boolean; lastSeen: number}
  >()
  private name: string | null = null
  private call: Call | null = null
  private notice: string | null = null

  private snapshot!: Snapshot
  private listeners = new Set<() => void>()

  /** Last name used on this browser, for prefilling the join form. */
  readonly savedName: string = localStorage.getItem(NAME_KEY) ?? ''

  constructor() {
    this.rebuildSnapshot()
    this.rootReady = rootTopic(ROOM_ID)
    void this.start()
    if (this.savedName) this.join(this.savedName)
  }

  private async start() {
    const root = await this.rootReady

    // Call requests + WebRTC signaling addressed to us.
    const selfTopic = await peerTopic(root, selfId)
    this.nostr.subscribe(selfTopic, (content, from) => {
      if (from === selfId) return
      let msg: PeerMsg
      try {
        msg = JSON.parse(content)
      } catch {
        return
      }
      this.handlePeerMsg(from, msg)
    })

    // Presence announcements.
    this.nostr.subscribe(root, (content, from) => {
      if (from === selfId) return
      let ann: Partial<Announcement>
      try {
        ann = JSON.parse(content)
      } catch {
        return
      }
      if (ann.peerId !== from || typeof ann.name !== 'string') return
      const prev = this.presence.get(from)
      const busy = ann.busy === true
      this.presence.set(from, {name: ann.name, busy, lastSeen: Date.now()})
      if (!prev || prev.name !== ann.name || prev.busy !== busy) {
        this.rebuildSnapshot()
      }
    })

    setInterval(() => void this.announce(), ANNOUNCE_INTERVAL_MS)
    setInterval(() => this.sweepPresence(), ANNOUNCE_INTERVAL_MS)

    window.addEventListener('online', () => void this.announce())
  }

  private async announce() {
    if (!this.name) return
    const root = await this.rootReady
    const ann: Announcement = {
      peerId: selfId,
      name: this.name,
      busy: this.call !== null
    }
    void this.nostr.publish(root, JSON.stringify(ann))
  }

  private sweepPresence() {
    const cutoff = Date.now() - PRESENCE_TTL_MS
    let changed = false
    for (const [peerId, p] of this.presence) {
      if (p.lastSeen < cutoff) {
        this.presence.delete(peerId)
        changed = true
      }
    }
    if (changed) this.rebuildSnapshot()
  }

  private async sendToPeer(peerId: string, msg: PeerMsg) {
    const root = await this.rootReady
    const topic = await peerTopic(root, peerId)
    void this.nostr.publish(topic, JSON.stringify(msg))
  }

  // ---- incoming messages ------------------------------------------------

  private handlePeerMsg(from: string, msg: PeerMsg) {
    switch (msg.t) {
      case 'call-request': {
        if (this.call) {
          if (this.call.peerId !== from) {
            // Busy with someone else.
            void this.sendToPeer(from, {t: 'call-decline', busy: true})
          } else if (this.call.phase === 'outgoing') {
            // Glare: we each called the other — that's mutual agreement.
            this.beginConnecting()
          } else if (
            this.call.phase === 'connecting' ||
            this.call.phase === 'connected'
          ) {
            // Their resent ring means our accept was lost; send it again.
            void this.sendToPeer(from, {
              t: 'call-accept',
              name: this.name ?? ''
            })
          }
          // phase 'incoming': duplicate ring, ignore.
          return
        }
        if (!this.name) {
          // Not joined; we shouldn't be getting calls — turn them away.
          void this.sendToPeer(from, {t: 'call-decline', busy: true})
          return
        }
        this.notice = null
        this.call = this.newCall('incoming', from, msg.name)
        this.rebuildSnapshot()
        void this.announce()
        return
      }

      case 'call-accept': {
        if (this.call?.phase === 'outgoing' && this.call.peerId === from) {
          if (msg.name) this.call.peerName = msg.name
          this.beginConnecting()
        }
        return
      }

      case 'call-decline': {
        if (this.call?.peerId === from && this.call.phase === 'outgoing') {
          const who = this.call.peerName
          this.teardown(msg.busy ? `${who} is busy.` : `${who} declined.`)
        }
        return
      }

      case 'call-cancel': {
        if (this.call?.peerId === from) {
          this.teardown(`${this.call.peerName} canceled the call.`)
        }
        return
      }

      case 'hang-up': {
        if (this.call?.peerId === from) {
          this.teardown(`${this.call.peerName} hung up.`)
        }
        return
      }

      case 'signal': {
        const call = this.call
        if (!call || call.peerId !== from) return
        if (call.phase !== 'connecting' && call.phase !== 'connected') return
        if (call.peer) void call.peer.signal(msg.signal)
        else call.pendingSignals.push(msg.signal)
        return
      }
    }
  }

  // ---- call lifecycle ---------------------------------------------------

  private newCall(phase: CallPhase, peerId: string, peerName: string): Call {
    return {
      phase,
      peerId,
      peerName,
      peer: null,
      localStream: null,
      remoteStream: null,
      pendingSignals: [],
      ringInterval: null,
      ringTimeout: null,
      connectTimeout: null
    }
  }

  private clearCallTimers(call: Call) {
    if (call.ringInterval !== null) clearInterval(call.ringInterval)
    if (call.ringTimeout !== null) clearTimeout(call.ringTimeout)
    if (call.connectTimeout !== null) clearTimeout(call.connectTimeout)
    call.ringInterval = null
    call.ringTimeout = null
    call.connectTimeout = null
  }

  /** Both sides agreed: get the camera/mic and bring up the WebRTC call. */
  private beginConnecting() {
    const call = this.call
    if (!call || call.phase === 'connecting' || call.phase === 'connected') {
      return
    }
    this.clearCallTimers(call)
    call.phase = 'connecting'
    call.connectTimeout = window.setTimeout(() => {
      if (this.call === call && call.phase === 'connecting') {
        void this.sendToPeer(call.peerId, {t: 'hang-up'})
        this.teardown('Could not establish a connection.')
      }
    }, CONNECT_TIMEOUT_MS)
    this.rebuildSnapshot()
    void this.startMedia(call)
  }

  private async startMedia(call: Call) {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      })
    } catch {
      if (this.call === call) {
        void this.sendToPeer(call.peerId, {t: 'hang-up'})
        this.teardown('Could not access your camera/microphone.')
      }
      return
    }
    if (this.call !== call || call.phase !== 'connecting') {
      // The call went away while we were waiting for permission.
      for (const track of stream.getTracks()) track.stop()
      return
    }

    call.localStream = stream
    // Deterministic initiator (no glare): the smaller peer ID makes the offer.
    const peer = new Peer(selfId < call.peerId, stream)
    call.peer = peer
    peer.setHandlers({
      signal: signal => {
        void this.sendToPeer(call.peerId, {t: 'signal', signal})
      },
      track: remote => {
        if (this.call !== call) return
        call.remoteStream = remote
        this.rebuildSnapshot()
      },
      connect: () => {
        if (this.call !== call) return
        call.phase = 'connected'
        this.clearCallTimers(call)
        this.rebuildSnapshot()
      },
      data: raw => {
        let msg: {t?: string}
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        if (msg.t === 'hang-up' && this.call === call) {
          this.teardown(`${call.peerName} hung up.`)
        }
      },
      close: () => {
        if (this.call === call) this.teardown('Call ended.')
      }
    })
    for (const signal of call.pendingSignals.splice(0)) {
      void peer.signal(signal)
    }
    this.rebuildSnapshot()
  }

  private teardown(notice: string | null) {
    const call = this.call
    if (!call) return
    this.call = null // cleared first so the peer's close handler no-ops
    this.clearCallTimers(call)
    call.peer?.destroy()
    if (call.localStream) {
      for (const track of call.localStream.getTracks()) track.stop()
    }
    this.notice = notice
    this.rebuildSnapshot()
    void this.announce()
  }

  // ---- public API -------------------------------------------------------

  join(name: string) {
    const trimmed = name.trim().slice(0, 40)
    if (!trimmed) return
    this.name = trimmed
    localStorage.setItem(NAME_KEY, trimmed)
    this.notice = null
    this.rebuildSnapshot()
    void this.announce()
  }

  leave() {
    if (this.call) this.endCall()
    this.name = null
    this.rebuildSnapshot()
    // Others will drop us from their rosters when announcements stop.
  }

  callPeer(peerId: string) {
    if (!this.name || this.call || peerId === selfId) return
    const peerName = this.presence.get(peerId)?.name ?? peerId.slice(0, 8)
    this.notice = null
    const call = this.newCall('outgoing', peerId, peerName)
    this.call = call
    const ring = () => void this.sendToPeer(peerId, {
      t: 'call-request',
      name: this.name ?? ''
    })
    ring()
    call.ringInterval = window.setInterval(ring, RING_RESEND_MS)
    call.ringTimeout = window.setTimeout(() => {
      if (this.call === call && call.phase === 'outgoing') {
        void this.sendToPeer(peerId, {t: 'call-cancel'})
        this.teardown(`${call.peerName} did not answer.`)
      }
    }, RING_TIMEOUT_MS)
    this.rebuildSnapshot()
    void this.announce()
  }

  accept() {
    const call = this.call
    if (!call || call.phase !== 'incoming') return
    void this.sendToPeer(call.peerId, {t: 'call-accept', name: this.name ?? ''})
    this.beginConnecting()
  }

  decline() {
    const call = this.call
    if (!call || call.phase !== 'incoming') return
    void this.sendToPeer(call.peerId, {t: 'call-decline'})
    this.teardown(null)
  }

  endCall() {
    const call = this.call
    if (!call) return
    if (call.phase === 'outgoing') {
      void this.sendToPeer(call.peerId, {t: 'call-cancel'})
    } else if (call.phase === 'incoming') {
      void this.sendToPeer(call.peerId, {t: 'call-decline'})
    } else {
      // Belt and braces: the control channel may not be open yet.
      call.peer?.send(JSON.stringify({t: 'hang-up'}))
      void this.sendToPeer(call.peerId, {t: 'hang-up'})
    }
    this.teardown(null)
  }

  dismissNotice() {
    this.notice = null
    this.rebuildSnapshot()
  }

  getSnapshot = (): Snapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private rebuildSnapshot() {
    const roster: RosterEntry[] = [...this.presence.entries()]
      .map(([peerId, p]) => ({peerId, name: p.name, busy: p.busy}))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) || a.peerId.localeCompare(b.peerId)
      )
    const call: CallInfo | null = this.call
      ? {
          phase: this.call.phase,
          peerId: this.call.peerId,
          peerName: this.call.peerName,
          localStream: this.call.localStream,
          remoteStream: this.call.remoteStream
        }
      : null
    this.snapshot = {
      selfId,
      name: this.name,
      roster,
      call,
      notice: this.notice
    }
    for (const l of this.listeners) l()
  }
}
