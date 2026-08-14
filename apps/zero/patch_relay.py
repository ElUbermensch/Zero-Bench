import pathlib
Z = pathlib.Path('Zero.jsx'); src = Z.read_text(encoding='utf-8')
core = pathlib.Path('../../packages/zero-core/zero-core.js').read_text(encoding='utf-8')
core = core.replace("if (typeof module !== 'undefined' && module.exports) module.exports = ZeroCore;\n", "")

def rep(old, new, n=1):
    global src
    assert old in src, "ANCHOR MISSING:\n" + old[:160]
    src = src.replace(old, new, n)

# 1. refresh the embedded zero-core (now carries anonymous auth + relay client)
start = src.index("const ZeroCore = (() => {")
end = src.index("/* ── Shared deployment ")
src = src[:start] + core + "\n" + src[end:]

# 2. relay viewer + join form
rep("function SyncPanel({ core, cfg, onSaveCfg, sessions, ammo, getTarget, onSessionsUpdated }) {",
r'''/* ══════════════════════════════════════════════════════════════════════════
 * LIVE RELAY — the pair-firing kit.
 *
 * A shooter taps "go live" and reads a 4-character code aloud. A coach taps
 * "join live", enters the code, their name and a role, and watches the string
 * build with a shared feed for wind calls.
 *
 * Deliberately polled, not socketed: a coach's phone is backgrounded for most
 * of a string, browsers throttle background timers, the heartbeat stops, and
 * the server drops the socket without the client noticing. Polling has no
 * connection to lose.
 * ════════════════════════════════════════════════════════════════════════ */

/* Statistics from relayed points alone. No target geometry required -- ES and
 * mean radius are pure point geometry, and score is the sum of ring labels. */
function relayStats(shots) {
  const rec = shots.filter(s => !s.is_sighter);
  const pts = rec.map(s => ({ x: +s.x_in || 0, y: +s.y_in || 0 }));
  const score = rec.reduce((a, s) => a + (s.ring === 'X' ? 10 : (+s.ring || 0)), 0);
  const xs = rec.filter(s => s.ring === 'X').length;
  if (pts.length < 2) return { n: pts.length, score, xs, mr: null, es: null, pts, cx: 0, cy: 0 };
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const mr = pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  let es = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      es = Math.max(es, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return { n: pts.length, score, xs, mr, es, pts, cx, cy };
}

/* Minimal scatter in Zero's existing chart idiom -- same CSS variables as
 * GroupPlot and SightChart, so it reads as part of the app rather than as a
 * second design system bolted on. */
function RelayPlot({ stats, yards }) {
  const SZ = 190, pad = 14;
  const { pts, cx, cy, mr } = stats;
  if (!pts.length) return null;
  const span = Math.max(0.6, ...pts.map(p => Math.hypot(p.x - cx, p.y - cy) * 2.4));
  const k = (SZ / 2 - pad) / (span / 2);
  const px = p => SZ / 2 + (p.x - cx) * k;
  const py = p => SZ / 2 - (p.y - cy) * k;
  return (
    <svg width="100%" viewBox={`0 0 ${SZ} ${SZ}`} style={{ maxWidth: 240, display: 'block', margin: '0 auto' }}>
      <rect width={SZ} height={SZ} fill="var(--surf2)" rx="6"/>
      <line x1={SZ/2} y1={pad/2} x2={SZ/2} y2={SZ-pad/2} stroke="var(--bdr)" strokeWidth="1"/>
      <line x1={pad/2} y1={SZ/2} x2={SZ-pad/2} y2={SZ/2} stroke="var(--bdr)" strokeWidth="1"/>
      {mr != null && <circle cx={SZ/2} cy={SZ/2} r={mr * k} fill="none"
        stroke="var(--acc)" strokeWidth="1" strokeDasharray="3 3" opacity="0.65"/>}
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={px(p)} cy={py(p)} r="5" fill="var(--acc)" opacity="0.85"/>
          <text x={px(p)} y={py(p) + 3} textAnchor="middle"
            style={{ fontFamily: 'var(--fm)', fontSize: 7, fill: '#1a1d27', fontWeight: 700 }}>{i + 1}</text>
        </g>
      ))}
      <text x={SZ/2} y={SZ - 3} textAnchor="middle"
        style={{ fontFamily: 'var(--fm)', fontSize: 7, fill: 'var(--dim)' }}>
        dashed ring = mean radius{yards ? ` · ${yards}yd` : ''}</text>
    </svg>
  );
}

function RelayViewer({ core, onExit }) {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState('');
  const [ended, setEnded] = useState(false);
  const feedRef = useRef(null);

  useEffect(() => {
    const offs = [
      core.on(core.EVENTS.RELAY_STATE, p => setState(p)),
      core.on(core.EVENTS.RELAY_ENDED, () => setEnded(true)),
    ];
    return () => offs.forEach(o => o());
  }, [core]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [state?.messages?.length]);

  const info = core.relayInfo();
  const shots = state?.shots || [];
  const st = relayStats(shots);
  const relay = state?.relay;

  const send = (kind) => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    core.relaySend(body, kind);
  };

  const cell = { textAlign: 'center', flex: 1 };
  const val = { fontFamily: 'var(--fm)', fontSize: 17, fontWeight: 700, color: 'var(--acc)' };
  const lab = { fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)',
                textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2 };

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <button className="bback" onClick={() => { core.stopRelay(); onExit(); }}>← leave</button>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: ended ? 'var(--dim)' : 'var(--green)' }}>
            {ended ? '○ ended' : '● live'} · {info?.code}
          </div>
        </div>
        <div className="content">
          <div style={{ padding: '13px 13px 4px' }}>
            <div style={{ fontFamily: 'var(--fh)', fontSize: 18, fontWeight: 700 }}>
              {relay?.host_name || 'Shooter'}{relay?.title ? ` · ${relay.title}` : ''}
            </div>
            <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>
              {[relay?.target_name, relay?.distance_yd && `${relay.distance_yd}yd`,
                (state?.participants || []).map(p => p.name).join(', ')].filter(Boolean).join(' · ')}
            </div>
          </div>

          {ended && (
            <div className="tcard" style={{ padding: '11px 13px' }}>
              <div style={{ fontFamily: 'var(--fm)', fontSize: 11, color: 'var(--dim)' }}>
                The shooter ended this relay. The string below is the final state.
              </div>
            </div>
          )}

          <div className="tcard" style={{ padding: '11px 13px' }}>
            <div style={{ display: 'flex', marginBottom: 10 }}>
              <div style={cell}><div style={val}>{st.score}<span style={{ fontSize: 11, color: 'var(--dim)' }}>–{st.xs}X</span></div><div style={lab}>Score</div></div>
              <div style={cell}><div style={val}>{st.mr != null ? st.mr.toFixed(2) : '—'}</div><div style={lab}>MR in</div></div>
              <div style={cell}><div style={val}>{st.es != null ? st.es.toFixed(2) : '—'}</div><div style={lab}>ES in</div></div>
              <div style={cell}><div style={val}>{st.n}</div><div style={lab}>Shots</div></div>
            </div>
            {st.pts.length > 0
              ? <RelayPlot stats={st} yards={relay?.distance_yd}/>
              : <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--dim)', textAlign: 'center', padding: '14px 0' }}>
                  Waiting for the first shot…
                </div>}
          </div>

          {shots.length > 0 && (
            <div className="tcard" style={{ padding: '11px 13px' }}>
              <div className="lbl" style={{ marginBottom: 6 }}>Shot string</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {shots.map((s, i) => (
                  <div key={s.id} style={{ fontFamily: 'var(--fm)', fontSize: 11,
                    padding: '3px 7px', borderRadius: 4,
                    background: s.is_sighter ? 'transparent' : 'var(--surf2)',
                    border: s.is_sighter ? '1px dashed var(--bdr)' : '1px solid var(--bdr)',
                    color: s.ring === 'X' ? 'var(--acc)' : 'var(--ink)' }}>
                    {s.is_sighter ? 'S' : i + 1}<span style={{ color: 'var(--dim)' }}>·</span>{s.ring}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="tcard" style={{ padding: '11px 13px' }}>
            <div className="lbl" style={{ marginBottom: 6 }}>Feed</div>
            <div ref={feedRef} style={{ maxHeight: 190, overflowY: 'auto', marginBottom: 8 }}>
              {(state?.messages || []).length === 0 && (
                <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--dim)' }}>
                  Wind calls and chatter appear here.
                </div>)}
              {(state?.messages || []).map(m => (
                <div key={m.id} style={{ marginBottom: 5 }}>
                  <span style={{ fontFamily: 'var(--fm)', fontSize: 9,
                    color: m.kind === 'wind' ? 'var(--acc)' : 'var(--dim)' }}>
                    {m.kind === 'wind' ? '◈ ' : ''}{m.author_name}
                  </span>
                  <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>{m.body}</div>
                </div>
              ))}
            </div>
            {!ended && (
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="inp" value={draft} maxLength={500}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') send('chat'); }}
                  placeholder="message" style={{ flex: 1 }}/>
                <button className="badd" onClick={() => send('wind')}
                  style={{ fontSize: 10, padding: '5px 9px' }}>wind</button>
                <button className="badd" onClick={() => send('chat')}
                  style={{ fontSize: 10, padding: '5px 9px' }}>send</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function JoinLiveForm({ core, onJoined, onCancel }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('coach');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function go() {
    setBusy(true); setErr(null);
    const r = await core.joinRelay(code, name || 'Guest', role);
    setBusy(false);
    if (!r.ok) {
      setErr(r.message || (r.reason === 'throttled'
        ? 'Too many attempts. Wait a few minutes.'
        : 'No live relay with that code.'));
      return;
    }
    onJoined();
  }

  const inp = { width: '100%', background: 'var(--surf2)', border: '1px solid var(--bdr)',
                borderRadius: 5, padding: '9px 10px', color: 'var(--ink)',
                fontFamily: 'var(--fm)', fontSize: 12, marginBottom: 7 };

  return (
    <div className="tcard" style={{ padding: '11px 13px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="lbl">Join a live relay</div>
        <button onClick={onCancel} style={{ background: 'none', border: 'none',
          color: 'var(--dim)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
      </div>
      <input style={{ ...inp, fontSize: 22, letterSpacing: '.28em', textAlign: 'center' }}
        value={code} maxLength={4} autoCapitalize="characters" autoComplete="off"
        onChange={e => setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))}
        placeholder="CODE"/>
      <input style={inp} value={name} onChange={e => setName(e.target.value)}
        placeholder="your name" maxLength={40}/>
      <select style={inp} value={role} onChange={e => setRole(e.target.value)}>
        <option value="coach">Coach — spotting / calling wind</option>
        <option value="shooter">Shooter — firing partner</option>
      </select>
      <button className="badd" style={{ width: '100%', opacity: (code.length === 4 && !busy) ? 1 : 0.4 }}
        disabled={code.length !== 4 || busy} onClick={go}>
        {busy ? 'joining…' : '● join live'}</button>
      {err && <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--red)', marginTop: 7 }}>{err}</div>}
      <div style={{ fontFamily: 'var(--fm)', fontSize: 8.5, color: 'var(--dim)', marginTop: 7, lineHeight: 1.5 }}>
        No account needed. The code works only while the shooter is live.
      </div>
    </div>
  );
}

function SyncPanel({ core, cfg, onSaveCfg, sessions, ammo, getTarget, onSessionsUpdated }) {''')

Z.write_text(src, encoding='utf-8')
print('viewer + join form added:', src.count(chr(10)) + 1, 'lines')
