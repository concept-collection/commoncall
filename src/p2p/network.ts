import {selfId} from './identity'
import {Nostr, peerTopic, rootTopic} from './nostr'
import {Peer, type Signal} from './peer'
import {
  DEFAULT_SETTINGS,
  QUALITY_PARAMS,
  SETTING_VALIDATORS,
  type CallSettings,
  type VideoQuality
} from './settings'

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

// Messages on the in-call control data channel (WebRTC, not nostr).
type ControlMsg =
  | {t: 'hang-up'}
  | {t: 'set'; key: string; value: unknown; rev: number}
  | {t: 'mute'; audio: boolean; video: boolean}

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
  /** Set while the outgoing video track is a screen capture, not the camera. */
  screenStream: MediaStream | null
  /** Signals that arrived before our getUserMedia resolved. */
  pendingSignals: Signal[]
  /** Shared settings for this call, synced over the control channel. */
  settings: CallSettings
  /** Per-key revision counters for the last-writer-wins settings sync. */
  settingsRevs: Partial<Record<keyof CallSettings, number>>
  /** Local mute state (audio = mic; video = camera, latent while sharing). */
  audioMuted: boolean
  videoMuted: boolean
  /** The other party's effective outgoing mute state, as they reported it. */
  peerAudioMuted: boolean
  peerVideoMuted: boolean
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
  screenStream: MediaStream | null
  settings: CallSettings
  audioMuted: boolean
  videoMuted: boolean
  peerAudioMuted: boolean
  peerVideoMuted: boolean
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
      screenStream: null,
      pendingSignals: [],
      settings: {...DEFAULT_SETTINGS},
      settingsRevs: {},
      audioMuted: false,
      videoMuted: false,
      peerAudioMuted: false,
      peerVideoMuted: false,
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
        if (this.call !== call) return
        let msg: ControlMsg
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        if (msg.t === 'hang-up') {
          this.teardown(`${call.peerName} hung up.`)
        } else if (msg.t === 'set') {
          this.applyRemoteSetting(call, msg)
        } else if (msg.t === 'mute') {
          if (typeof msg.audio !== 'boolean' || typeof msg.video !== 'boolean') {
            return
          }
          call.peerAudioMuted = msg.audio
          call.peerVideoMuted = msg.video
          this.rebuildSnapshot()
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

  // ---- shared call settings --------------------------------------------
  //
  // One settings object per call, visible and editable by BOTH parties.
  // Sync is per-key last-writer-wins over the control channel: every change
  // bumps that key's revision counter and is sent as {t:'set'}. The channel
  // is reliable and ordered, so divergence only happens when both sides
  // change the same key concurrently (same revision) — that tie must resolve
  // identically on both sides, so the smaller peer ID's value wins.

  private setSetting<K extends keyof CallSettings>(
    key: K,
    value: CallSettings[K]
  ) {
    const call = this.call
    if (!call || !call.peer || call.settings[key] === value) return
    const rev = (call.settingsRevs[key] ?? 0) + 1
    call.settingsRevs[key] = rev
    call.settings = {...call.settings}
    call.settings[key] = value
    call.peer.send(JSON.stringify({t: 'set', key, value, rev}))
    this.settingChanged(call, key)
    this.rebuildSnapshot()
  }

  private applyRemoteSetting(
    call: Call,
    msg: {key: string; value: unknown; rev: number}
  ) {
    if (!(msg.key in SETTING_VALIDATORS)) return
    const key = msg.key as keyof CallSettings
    if (!SETTING_VALIDATORS[key](msg.value)) return
    if (!Number.isInteger(msg.rev) || msg.rev < 1) return
    const localRev = call.settingsRevs[key] ?? 0
    if (msg.rev < localRev) return // stale
    if (msg.rev === localRev && selfId < call.peerId) return // tie: we win
    call.settingsRevs[key] = msg.rev
    if (call.settings[key] === msg.value) return
    call.settings = {...call.settings}
    call.settings[key] = msg.value
    this.settingChanged(call, key)
    this.rebuildSnapshot()
  }

  /** Side effects of a setting taking a new value (local or remote). */
  private settingChanged(call: Call, key: keyof CallSettings) {
    if (key === 'videoQuality') this.applyVideoParams(call)
  }

  /** Push the current quality preset into the outgoing video sender. */
  private applyVideoParams(call: Call) {
    if (!call.peer) return
    const p = QUALITY_PARAMS[call.settings.videoQuality]
    const sharing = call.screenStream !== null
    void call.peer.setVideoParameters({
      maxBitrate: p.maxBitrate,
      // Downscaled screen text is unreadable: while sharing, send full
      // resolution and let the bitrate/framerate caps do the limiting.
      scaleResolutionDownBy: sharing ? undefined : p.scaleResolutionDownBy,
      maxFramerate: p.maxFramerate,
      degradationPreference: sharing ? 'maintain-resolution' : undefined
    })
  }

  // ---- mute ------------------------------------------------------------
  //
  // Mute is per-party state, not a shared setting: each side owns its own
  // flags (so no revision counters — the ordered channel makes last-sent
  // win naturally) and just notifies the other side. Toggling track.enabled
  // sends silence/black frames without renegotiation.

  setAudioMuted(muted: boolean) {
    const call = this.call
    if (!call || !call.localStream || call.audioMuted === muted) return
    call.audioMuted = muted
    for (const t of call.localStream.getAudioTracks()) t.enabled = !muted
    this.sendMuteNotice(call)
    this.rebuildSnapshot()
  }

  setVideoMuted(muted: boolean) {
    const call = this.call
    if (!call || !call.localStream || call.videoMuted === muted) return
    call.videoMuted = muted
    for (const t of call.localStream.getVideoTracks()) t.enabled = !muted
    this.sendMuteNotice(call)
    this.rebuildSnapshot()
  }

  /** Tell the peer our EFFECTIVE outgoing mute state: while screen sharing
   *  the outgoing video is the (always live) screen, so a muted camera is
   *  latent until the share ends. */
  private sendMuteNotice(call: Call) {
    call.peer?.send(
      JSON.stringify({
        t: 'mute',
        audio: call.audioMuted,
        video: call.videoMuted && !call.screenStream
      })
    )
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
    if (call.screenStream) {
      for (const track of call.screenStream.getTracks()) track.stop()
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

  /** Change the shared video-quality preset. It applies to BOTH senders:
   *  each side caps its own outgoing video, and the change syncs across. */
  setVideoQuality(quality: VideoQuality) {
    this.setSetting('videoQuality', quality)
  }

  /** Swap the outgoing camera track for a screen capture. The remote side
   *  sees the screen in place of the camera; no renegotiation involved. */
  async startScreenShare() {
    const call = this.call
    if (!call || !call.peer || call.screenStream) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({video: true})
    } catch {
      return // user canceled the picker (or capture is unsupported)
    }
    const track = stream.getVideoTracks()[0]
    const ok =
      this.call === call && call.peer && track
        ? await call.peer.replaceVideoTrack(track)
        : false
    if (!ok || this.call !== call) {
      for (const t of stream.getTracks()) t.stop()
      return
    }
    call.screenStream = stream
    this.applyVideoParams(call) // re-derive caps for screen-share mode
    this.sendMuteNotice(call) // outgoing video is now the live screen
    // The browser's own "Stop sharing" bar ends the track; swap back then.
    track.onended = () => void this.stopScreenShare()
    this.rebuildSnapshot()
  }

  async stopScreenShare() {
    const call = this.call
    if (!call || !call.screenStream) return
    const screen = call.screenStream
    call.screenStream = null
    const camTrack = call.localStream?.getVideoTracks()[0]
    if (call.peer && camTrack) await call.peer.replaceVideoTrack(camTrack)
    for (const t of screen.getTracks()) t.stop()
    if (this.call === call) {
      this.applyVideoParams(call) // restore camera-mode caps
      this.sendMuteNotice(call) // the camera, with its mute state, is back
      this.rebuildSnapshot()
    }
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
          remoteStream: this.call.remoteStream,
          screenStream: this.call.screenStream,
          settings: this.call.settings,
          audioMuted: this.call.audioMuted,
          videoMuted: this.call.videoMuted,
          peerAudioMuted: this.call.peerAudioMuted,
          peerVideoMuted: this.call.peerVideoMuted
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
