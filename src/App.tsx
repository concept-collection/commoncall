import {useEffect, useRef, useState} from 'react'
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
            {canShareScreen && (
              <button
                style={
                  call.phase === 'connected'
                    ? btn
                    : {...btn, ...disabledStyle}
                }
                disabled={call.phase !== 'connected'}
                onClick={() =>
                  call.screenStream
                    ? void network.stopScreenShare()
                    : void network.startScreenShare()
                }
              >
                {call.screenStream ? 'Stop sharing' : 'Share screen'}
              </button>
            )}
            <button style={dangerBtn} onClick={() => network.endCall()}>
              Hang up
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
