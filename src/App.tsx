import {useEffect, useRef, useState} from 'react'
import {VIDEO_QUALITIES, type VideoQuality} from './p2p/settings'
import {useNetwork} from './useNetwork'

const short = (id: string) => id.slice(0, 8) + '…'

// Screen capture is desktop-only in practice; hide the button where the API
// doesn't exist (most mobile browsers).
const canShareScreen =
  typeof navigator.mediaDevices?.getDisplayMedia === 'function'

const btn: React.CSSProperties = {
  padding: '0.4rem 1rem',
  borderRadius: 6,
  border: '1px solid #888',
  background: '#fff',
  cursor: 'pointer',
  fontSize: '1rem'
}

const primaryBtn: React.CSSProperties = {
  ...btn,
  background: '#1a7f37',
  borderColor: '#1a7f37',
  color: '#fff'
}

const dangerBtn: React.CSSProperties = {
  ...btn,
  background: '#c62828',
  borderColor: '#c62828',
  color: '#fff'
}

// Merged into a button's style whenever it is disabled, so the explicit
// background colors above don't leave a disabled button looking clickable.
const disabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: 'not-allowed'
}

// Square icon-only buttons for the in-call bar. Their meaning is carried by
// the icon plus a title tooltip and aria-label.
const iconBtn: React.CSSProperties = {
  ...btn,
  padding: '0.45rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center'
}

// An icon button whose state is engaged (muted / sharing).
const engagedIconBtn: React.CSSProperties = {
  ...iconBtn,
  background: '#555',
  borderColor: '#555',
  color: '#fff'
}

const dangerIconBtn: React.CSSProperties = {
  ...iconBtn,
  background: '#c62828',
  borderColor: '#c62828',
  color: '#fff'
}

// Badge overlaid on the remote video reporting the other party's mute state.
const muteChip: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.65)',
  color: '#fff',
  borderRadius: 999,
  padding: '0.3rem',
  display: 'inline-flex',
  alignItems: 'center'
}

// Stroke-style icon paths (Feather icons, MIT), drawn with currentColor.
const ICONS = {
  mic: (
    <>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v4" />
      <path d="M8 23h8" />
    </>
  ),
  micOff: (
    <>
      <path d="M1 1l22 22" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <path d="M12 19v4" />
      <path d="M8 23h8" />
    </>
  ),
  video: (
    <>
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </>
  ),
  videoOff: (
    <>
      <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
      <path d="M1 1l22 22" />
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </>
  ),
  phone: (
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  )
} as const

function Icon({
  name,
  size = 18,
  style
}: {
  name: keyof typeof ICONS
  size?: number
  style?: React.CSSProperties
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{display: 'block', ...style}}
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  )
}

function VideoView({
  stream,
  muted,
  style
}: {
  stream: MediaStream | null
  muted: boolean
  style: React.CSSProperties
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream
    }
  }, [stream])
  return <video ref={ref} autoPlay playsInline muted={muted} style={style} />
}

function JoinForm({onJoin, initial}: {onJoin: (name: string) => void; initial: string}) {
  const [name, setName] = useState(initial)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    onJoin(name)
  }
  return (
    <form onSubmit={submit} style={{marginTop: '1rem'}}>
      <p>Enter an ID so other visitors can see you and call you:</p>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="your id"
        maxLength={40}
        style={{padding: '0.4rem', fontSize: '1rem', marginRight: '0.5rem'}}
      />
      <button type="submit" style={primaryBtn} disabled={!name.trim()}>
        Join
      </button>
    </form>
  )
}

export default function App() {
  const {snapshot, network} = useNetwork()
  const {selfId, name, roster, call, notice} = snapshot

  const inCall = call?.phase === 'connecting' || call?.phase === 'connected'

  return (
    <div
      style={{
        fontFamily: 'sans-serif',
        maxWidth: 720,
        margin: '2rem auto',
        padding: '0 1rem'
      }}
    >
      <h1 style={{marginBottom: '0.25rem'}}>CommonCall</h1>
      <p style={{color: '#666', marginTop: 0}}>
        Peer-to-peer video calls. No server: presence and call setup ride over
        public nostr relays; audio/video flows directly over WebRTC.
      </p>

      {notice && (
        <div
          style={{
            background: '#fff3cd',
            border: '1px solid #e0c968',
            borderRadius: 6,
            padding: '0.5rem 0.75rem',
            margin: '0.75rem 0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <span>{notice}</span>
          <button style={btn} onClick={() => network.dismissNotice()}>
            OK
          </button>
        </div>
      )}

      {!name ? (
        <JoinForm onJoin={n => network.join(n)} initial={network.savedName} />
      ) : (
        <div style={{margin: '0.75rem 0', color: '#444'}}>
          You are <strong>{name}</strong>{' '}
          <code style={{color: '#999'}}>{short(selfId)}</code>{' '}
          <button
            style={{
              ...btn,
              fontSize: '0.85rem',
              padding: '0.2rem 0.6rem',
              ...(inCall ? disabledStyle : null)
            }}
            onClick={() => network.leave()}
            disabled={inCall}
          >
            Leave
          </button>
        </div>
      )}

      {call?.phase === 'incoming' && (
        <section
          style={{
            border: '2px solid #1a7f37',
            borderRadius: 8,
            padding: '1rem',
            margin: '1rem 0'
          }}
        >
          <p style={{marginTop: 0}}>
            <strong>{call.peerName}</strong>{' '}
            <code style={{color: '#999'}}>{short(call.peerId)}</code> wants to
            start a video call with you.
          </p>
          <button style={primaryBtn} onClick={() => network.accept()}>
            Accept
          </button>{' '}
          <button style={dangerBtn} onClick={() => network.decline()}>
            Decline
          </button>
        </section>
      )}

      {call?.phase === 'outgoing' && (
        <section
          style={{
            border: '1px solid #ccc',
            borderRadius: 8,
            padding: '1rem',
            margin: '1rem 0'
          }}
        >
          <p style={{marginTop: 0}}>
            Calling <strong>{call.peerName}</strong>… waiting for them to
            accept.
          </p>
          <button style={dangerBtn} onClick={() => network.endCall()}>
            Cancel
          </button>
        </section>
      )}

      {inCall && call && (
        <section
          style={{
            background: '#111',
            borderRadius: 8,
            padding: '0.75rem',
            margin: '1rem 0',
            color: '#eee'
          }}
        >
          <div style={{position: 'relative'}}>
            <VideoView
              stream={call.remoteStream}
              muted={false}
              style={{
                width: '100%',
                aspectRatio: '4 / 3',
                background: '#000',
                borderRadius: 6,
                objectFit: 'cover'
              }}
            />
            {(call.peerAudioMuted || call.peerVideoMuted) && (
              <div
                style={{
                  position: 'absolute',
                  top: 10,
                  left: 10,
                  display: 'flex',
                  gap: '0.4rem'
                }}
              >
                {call.peerAudioMuted && (
                  <span
                    style={muteChip}
                    title={`${call.peerName} muted their microphone`}
                  >
                    <Icon name="micOff" size={14} />
                  </span>
                )}
                {call.peerVideoMuted && (
                  <span
                    style={muteChip}
                    title={`${call.peerName} turned their camera off`}
                  >
                    <Icon name="videoOff" size={14} />
                  </span>
                )}
              </div>
            )}
            <VideoView
              stream={call.screenStream ?? call.localStream}
              muted
              style={{
                position: 'absolute',
                right: 10,
                bottom: 10,
                width: '25%',
                background: '#000',
                border: '1px solid #444',
                borderRadius: 6,
                // Mirror the camera preview, but never the shared screen.
                transform: call.screenStream ? undefined : 'scaleX(-1)'
              }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginTop: '0.5rem'
            }}
          >
            <span style={{flex: 1}}>
              {call.phase === 'connected'
                ? call.screenStream
                  ? `Sharing your screen with ${call.peerName}`
                  : `In a call with ${call.peerName}`
                : `Connecting to ${call.peerName}…`}
            </span>
            <button
              style={{
                ...(call.audioMuted ? engagedIconBtn : iconBtn),
                ...(call.localStream ? null : disabledStyle)
              }}
              disabled={!call.localStream}
              title={
                call.audioMuted
                  ? 'Unmute your microphone'
                  : 'Mute your microphone'
              }
              aria-label={
                call.audioMuted
                  ? 'Unmute your microphone'
                  : 'Mute your microphone'
              }
              onClick={() => network.setAudioMuted(!call.audioMuted)}
            >
              <Icon name={call.audioMuted ? 'micOff' : 'mic'} />
            </button>
            <button
              style={{
                ...(call.videoMuted ? engagedIconBtn : iconBtn),
                ...(call.localStream ? null : disabledStyle)
              }}
              disabled={!call.localStream}
              title={
                call.videoMuted
                  ? 'Turn your camera back on'
                  : 'Turn your camera off'
              }
              aria-label={
                call.videoMuted
                  ? 'Turn your camera back on'
                  : 'Turn your camera off'
              }
              onClick={() => network.setVideoMuted(!call.videoMuted)}
            >
              <Icon name={call.videoMuted ? 'videoOff' : 'video'} />
            </button>
            <label
              title="Video quality for both directions — either of you can change it"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                fontSize: '0.9rem'
              }}
            >
              Quality
              <select
                value={call.settings.videoQuality}
                disabled={call.phase !== 'connected'}
                onChange={e =>
                  network.setVideoQuality(e.target.value as VideoQuality)
                }
                style={{
                  padding: '0.3rem',
                  borderRadius: 6,
                  border: '1px solid #888',
                  background: '#fff',
                  fontSize: '0.9rem',
                  ...(call.phase !== 'connected' ? disabledStyle : null)
                }}
              >
                {VIDEO_QUALITIES.map(q => (
                  <option key={q} value={q}>
                    {q[0].toUpperCase() + q.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {canShareScreen && (
              <button
                style={{
                  ...(call.screenStream ? engagedIconBtn : iconBtn),
                  ...(call.phase === 'connected' ? null : disabledStyle)
                }}
                disabled={call.phase !== 'connected'}
                title={
                  call.screenStream
                    ? 'Stop sharing your screen'
                    : 'Share your screen'
                }
                aria-label={
                  call.screenStream
                    ? 'Stop sharing your screen'
                    : 'Share your screen'
                }
                onClick={() =>
                  call.screenStream
                    ? void network.stopScreenShare()
                    : void network.startScreenShare()
                }
              >
                <Icon name="monitor" />
              </button>
            )}
            <button
              style={dangerIconBtn}
              title="Hang up"
              aria-label="Hang up"
              onClick={() => network.endCall()}
            >
              <Icon name="phone" style={{transform: 'rotate(135deg)'}} />
            </button>
          </div>
        </section>
      )}

      <section>
        <h2>Visitors ({roster.length})</h2>
        {roster.length === 0 ? (
          <p style={{color: '#666'}}>
            Nobody else is here right now. Open this page in another browser or
            send the link to a friend.
          </p>
        ) : (
          <table style={{borderCollapse: 'collapse', width: '100%'}}>
            <tbody>
              {roster.map(p => (
                <tr key={p.peerId} style={{borderBottom: '1px solid #eee'}}>
                  <td style={{padding: '0.4rem'}}>
                    <strong>{p.name}</strong>{' '}
                    <code style={{color: '#999'}}>{short(p.peerId)}</code>
                  </td>
                  <td style={{padding: '0.4rem', color: '#666'}}>
                    {p.busy ? 'in a call' : 'available'}
                  </td>
                  <td style={{padding: '0.4rem', textAlign: 'right'}}>
                    {(() => {
                      const disabled = !name || call !== null || p.busy
                      return (
                        <button
                          style={disabled ? {...primaryBtn, ...disabledStyle} : primaryBtn}
                          disabled={disabled}
                          title={!name ? 'Enter an ID above to call' : undefined}
                          onClick={() => network.callPeer(p.peerId)}
                        >
                          Call
                        </button>
                      )
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!name && roster.length > 0 && (
          <p style={{color: '#666', fontSize: '0.9rem'}}>
            Enter an ID above to call someone.
          </p>
        )}
      </section>
    </div>
  )
}
