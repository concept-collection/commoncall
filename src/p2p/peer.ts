// A thin WebRTC wrapper, distilled from commonview's peer.ts. Instead of a
// data-only connection it carries the local audio/video tracks plus one small
// control data channel (hang-up, mute notices). As in commonview we avoid
// "perfect negotiation" glare handling by ensuring only ONE side (a
// deterministically chosen initiator) ever creates the offer.

export type Signal =
  | {type: 'offer'; sdp: string}
  | {type: 'answer'; sdp: string}
  | {type: 'candidate'; candidate: RTCIceCandidateInit}

/** Caps for the outgoing video encoding; an undefined field CLEARS that cap. */
export interface VideoSendParams {
  maxBitrate?: number
  scaleResolutionDownBy?: number
  maxFramerate?: number
  degradationPreference?: 'balanced' | 'maintain-framerate' | 'maintain-resolution'
}

export interface PeerHandlers {
  signal: (signal: Signal) => void
  /** Connection reached the 'connected' state. */
  connect: () => void
  /** Remote media stream became available. */
  track: (stream: MediaStream) => void
  /** A string message arrived on the control channel. */
  data: (data: string) => void
  close: () => void
}

export const ICE_SERVERS: RTCIceServer[] = [
  {urls: 'stun:stun.l.google.com:19302'},
  {urls: 'stun:stun1.l.google.com:19302'},
  {urls: 'stun:stun.cloudflare.com:3478'},
  // Free TURN relay (openrelayproject) — needed when direct/STUN pairing
  // fails (symmetric NAT, hairpinning, host-candidate blocking).
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
]

// A media call can survive a brief network blip: 'disconnected' often recovers
// on its own, so only tear down if it persists this long.
const DISCONNECT_GRACE_MS = 5000

export class Peer {
  private pc: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  /** Control messages sent before the channel opens; flushed on open. */
  private outbox: string[] = []
  private handlers: Partial<PeerHandlers> = {}
  private pendingCandidates: RTCIceCandidateInit[] = []
  private disconnectTimer: number | null = null
  private closed = false

  constructor(private initiator: boolean, localStream: MediaStream) {
    this.pc = new RTCPeerConnection({iceServers: ICE_SERVERS})

    // Both sides add their tracks up front: the initiator's single offer then
    // covers all media, and the answerer's tracks ride back in the answer.
    for (const track of localStream.getTracks()) {
      this.pc.addTrack(track, localStream)
    }

    this.pc.ontrack = ({streams}) => {
      if (streams[0]) this.handlers.track?.(streams[0])
    }

    this.pc.onicecandidate = ({candidate}) => {
      if (candidate) {
        this.handlers.signal?.({type: 'candidate', candidate: candidate.toJSON()})
      }
    }

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState
      if (s === 'connected') {
        this.clearDisconnectTimer()
        this.handlers.connect?.()
      } else if (s === 'failed' || s === 'closed') {
        this.destroy()
      } else if (s === 'disconnected') {
        this.clearDisconnectTimer()
        this.disconnectTimer = window.setTimeout(() => {
          if (this.pc.connectionState !== 'connected') this.destroy()
        }, DISCONNECT_GRACE_MS)
      }
    }

    if (initiator) {
      this.setupChannel(this.pc.createDataChannel('control'))
      this.pc.onnegotiationneeded = () => void this.makeOffer()
    } else {
      this.pc.ondatachannel = ({channel}) => this.setupChannel(channel)
    }
  }

  setHandlers(handlers: Partial<PeerHandlers>) {
    Object.assign(this.handlers, handlers)
  }

  private clearDisconnectTimer() {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer)
      this.disconnectTimer = null
    }
  }

  private setupChannel(channel: RTCDataChannel) {
    this.channel = channel
    const flush = () => {
      for (const data of this.outbox.splice(0)) channel.send(data)
    }
    if (channel.readyState === 'open') flush()
    else channel.onopen = flush
    channel.onclose = () => this.destroy()
    channel.onmessage = e => {
      if (typeof e.data === 'string') this.handlers.data?.(e.data)
    }
  }

  private async makeOffer() {
    if (this.closed) return
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer())
      this.handlers.signal?.({
        type: 'offer',
        sdp: this.pc.localDescription!.sdp
      })
    } catch {
      /* ignore */
    }
  }

  async signal(signal: Signal) {
    if (this.closed) return
    try {
      if (signal.type === 'candidate') {
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(signal.candidate)
        } else {
          this.pendingCandidates.push(signal.candidate)
        }
        return
      }

      if (signal.type === 'offer') {
        if (this.initiator) return // initiators never accept remote offers
        await this.pc.setRemoteDescription({type: 'offer', sdp: signal.sdp})
        await this.flushCandidates()
        await this.pc.setLocalDescription(await this.pc.createAnswer())
        this.handlers.signal?.({
          type: 'answer',
          sdp: this.pc.localDescription!.sdp
        })
        return
      }

      if (signal.type === 'answer') {
        await this.pc.setRemoteDescription({type: 'answer', sdp: signal.sdp})
        await this.flushCandidates()
      }
    } catch {
      /* ignore transient signaling errors */
    }
  }

  private async flushCandidates() {
    const queued = this.pendingCandidates.splice(0)
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(c)
      } catch {
        /* ignore */
      }
    }
  }

  send(data: string) {
    if (this.channel?.readyState === 'open') this.channel.send(data)
    else if (!this.closed) this.outbox.push(data)
  }

  /** Swap the outgoing video track in place (camera ↔ screen). A same-kind
   *  replaceTrack does not trigger renegotiation, so no signaling is needed
   *  and the one-offer design is preserved. */
  async replaceVideoTrack(track: MediaStreamTrack): Promise<boolean> {
    if (this.closed) return false
    const sender = this.pc.getSenders().find(s => s.track?.kind === 'video')
    if (!sender) return false
    try {
      await sender.replaceTrack(track)
      return true
    } catch {
      return false
    }
  }

  /** Cap (or uncap) the outgoing video encoding. Like replaceTrack,
   *  setParameters applies live with no renegotiation, so it fits the
   *  one-offer design. */
  async setVideoParameters(opts: VideoSendParams): Promise<boolean> {
    if (this.closed) return false
    const sender = this.pc.getSenders().find(s => s.track?.kind === 'video')
    if (!sender) return false
    const params = sender.getParameters()
    const enc = params.encodings[0]
    if (!enc) return false // no negotiated encoding yet
    if (opts.maxBitrate === undefined) delete enc.maxBitrate
    else enc.maxBitrate = opts.maxBitrate
    if (opts.scaleResolutionDownBy === undefined) {
      delete enc.scaleResolutionDownBy
    } else {
      enc.scaleResolutionDownBy = opts.scaleResolutionDownBy
    }
    if (opts.maxFramerate === undefined) delete enc.maxFramerate
    else enc.maxFramerate = opts.maxFramerate
    // Not in all TS dom typings, but supported by Chrome/Safari; harmless
    // where ignored.
    const p = params as {degradationPreference?: string}
    if (opts.degradationPreference === undefined) delete p.degradationPreference
    else p.degradationPreference = opts.degradationPreference
    try {
      await sender.setParameters(params)
      return true
    } catch {
      return false
    }
  }

  get isConnected(): boolean {
    return this.pc.connectionState === 'connected'
  }

  destroy() {
    if (this.closed) return
    this.closed = true
    this.clearDisconnectTimer()
    try {
      this.channel?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc.close()
    } catch {
      /* ignore */
    }
    this.handlers.close?.()
  }
}
