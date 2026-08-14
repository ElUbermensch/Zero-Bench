#!/usr/bin/env python3
"""Wire the live relay into Zero's UI: host controls, join entry, screen route,
and shot mirroring. Idempotent-ish: refuses to run twice by checking a marker."""
import io, sys, re

P = 'Zero.jsx'
src = io.open(P, encoding='utf-8').read()

if 'HostRelayCard' in src:
    sys.exit('already wired')

def sub1(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        sys.exit('anchor %s matched %d times' % (label, n))
    src = src.replace(old, new, 1)

# ────────────────────────────────────────────── 1. extract the shared feed
old_feed = """          <div className="tcard" style={{ padding: '11px 13px' }}>
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
          </div>"""
new_feed = """          <div className="tcard" style={{ padding: '11px 13px' }}>
            <RelayFeed core={core} messages={state?.messages} disabled={ended}/>
          </div>"""
sub1(old_feed, new_feed, 'viewer feed')

# the viewer's own draft/scroll state moves into RelayFeed
sub1("""  const [state, setState] = useState(null);
  const [draft, setDraft] = useState('');
  const [ended, setEnded] = useState(false);
  const feedRef = useRef(null);
""", """  const [state, setState] = useState(null);
  const [ended, setEnded] = useState(false);
""", 'viewer state')

sub1("""  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [state?.messages?.length]);

  const info = core.relayInfo();""", """  const info = core.relayInfo();""", 'viewer scroll effect')

sub1("""  const send = (kind) => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    core.relaySend(body, kind);
  };

  const cell""", """  const cell""", 'viewer send')

# ──────────────────────────────────────── 2. new components before SyncPanel
COMPONENTS = r"""/* The feed is the only two-way channel, and both ends render it identically --
 * one component rather than two that drift apart. Wind calls are tagged
 * separately from chatter because on a firing line "half value from 4" and
 * "nice shot" want different weight at a glance. */
function RelayFeed({ core, messages, disabled, maxHeight }) {
  const [draft, setDraft] = useState('');
  const ref = useRef(null);
  const list = messages || [];

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [list.length]);

  const send = (kind) => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    core.relaySend(body, kind);
  };

  return (
    <>
      <div className="lbl" style={{ marginBottom: 6 }}>Feed</div>
      <div ref={ref} style={{ maxHeight: maxHeight || 190, overflowY: 'auto', marginBottom: 8 }}>
        {list.length === 0 && (
          <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--dim)' }}>
            Wind calls and chatter appear here.
          </div>)}
        {list.map(m => (
          <div key={m.id} style={{ marginBottom: 5 }}>
            <span style={{ fontFamily: 'var(--fm)', fontSize: 9,
              color: m.kind === 'wind' ? 'var(--acc)' : 'var(--dim)' }}>
              {m.kind === 'wind' ? '◈ ' : ''}{m.author_name}
            </span>
            <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>{m.body}</div>
          </div>
        ))}
      </div>
      {!disabled && (
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
    </>
  );
}

/* One place to turn a relay failure into something a shooter can act on.
 * The anonymous-sign-in case is called out by name because it is the single
 * most likely first-run failure: the relay needs no accounts, but "no
 * accounts" is implemented as anonymous sign-in, which ships DISABLED. */
function relayErrText(r) {
  if (!r) return 'Could not reach the server. Check your connection.';
  if (r.reason === 'throttled') return 'Too many attempts. Wait a few minutes.';
  const e = String(r.error || '');
  if (/anonymous|signups? not allowed|signup_disabled/i.test(e))
    return 'Anonymous sign-in is disabled on the server. Enable it under Auth → Providers in the Supabase dashboard.';
  return r.message || 'Could not connect. Check your connection and try again.';
}

/* ── Host side ────────────────────────────────────────────────────────────
 * The shooter's own device. Deliberately compact: the shooter is on the line
 * and this must not push the shot list off the screen. It shows the code to
 * read aloud, who is actually watching, and the feed -- the feed is the whole
 * reason the host renders the relay at all, since wind calls travel coach →
 * shooter, not the other way. */
function HostRelayCard({ core, live, hostName, onHostName, onGoLive, onEndLive }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!core) return undefined;
    return core.on(core.EVENTS.RELAY_STATE, p => setState(p));
  }, [core]);
  useEffect(() => { if (!live) setState(null); }, [live]);

  if (!core) return null;

  const wrap = { margin: '8px 13px 0', background: 'var(--surf)',
                 border: '1px solid var(--bdr)', borderRadius: 9, padding: '11px 13px' };
  const note = { fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)',
                 lineHeight: 1.5, marginTop: 7 };

  if (!live) {
    return (
      <div style={wrap}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="inp" style={{ flex: 1, fontSize: 11, padding: '7px 9px' }}
            value={hostName} maxLength={40} placeholder="your name"
            onChange={e => onHostName(e.target.value)}/>
          <button className="badd" disabled={busy} style={{ opacity: busy ? 0.4 : 1, whiteSpace: 'nowrap' }}
            onClick={async () => {
              setBusy(true); setErr(null);
              const r = await onGoLive((hostName || '').trim() || 'Shooter');
              setBusy(false);
              if (!r || !r.ok) setErr(relayErrText(r));
            }}>{busy ? 'starting…' : '● go live'}</button>
        </div>
        <div style={note}>
          Hands you a 4-character code. Read it to your coach; they tap <b>● join</b> on
          their own phone and watch this string build, with a shared feed for wind calls.
          They need no account.
        </div>
        {err && <div style={{ ...note, color: 'var(--red)' }}>{err}</div>}
      </div>
    );
  }

  const info = core.relayInfo();
  const others = (state?.participants || []).filter(p => !p.is_self);
  // Presence comes free: relay_state stamps last_seen_at on every poll, so a
  // coach whose phone has gone dark stops being counted as watching. Polling
  // makes this honest in a way a WebSocket's "connected" flag was not.
  const now = state?.serverTime ? Date.parse(state.serverTime) : Date.now();
  const away = p => now - Date.parse(p.last_seen_at) > 20000;
  const watching = others.filter(p => !away(p));

  return (
    <div style={{ ...wrap, borderColor: 'var(--green)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 9, color: 'var(--green)',
            letterSpacing: '.1em', textTransform: 'uppercase' }}>● live · read this out</div>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 30, fontWeight: 700,
            letterSpacing: '.22em', color: 'var(--acc)', marginTop: 2 }}>{info?.code}</div>
        </div>
        <button className="badd" onClick={onEndLive}
          style={{ background: 'none', border: '1px solid var(--bdr)', color: 'var(--ink)' }}>end</button>
      </div>

      <div style={{ fontFamily: 'var(--fm)', fontSize: 9, marginTop: 6,
        color: watching.length ? 'var(--green)' : 'var(--dim)' }}>
        {others.length === 0
          ? 'Nobody has joined yet.'
          : others.map(p => `${p.name} (${p.role})${away(p) ? ' — away' : ''}`).join(' · ')}
      </div>

      <div style={{ marginTop: 9 }}>
        <RelayFeed core={core} messages={state?.messages} maxHeight={130}/>
      </div>

      <div style={note}>
        Shots mirror to your coach as you log them. Leaving this session does not end
        the relay — tap <b>end</b>, or it expires on its own.
      </div>
    </div>
  );
}

"""
sub1('function SyncPanel({ core, cfg, onSaveCfg, sessions, ammo, getTarget, onSessionsUpdated }) {',
     COMPONENTS + 'function SyncPanel({ core, cfg, onSaveCfg, sessions, ammo, getTarget, onSessionsUpdated }) {',
     'SyncPanel anchor')

# ────────────────────────────────────────────────── 3. SessionDetail plumbing
sub1('function SessionDetail({ session, target, firearm, match, sessions, ammo, onBack, onAddShot, onDelShot, onDelSess, core, onPublish }) {',
     'function SessionDetail({ session, target, firearm, match, sessions, ammo, onBack, onAddShot, onDelShot, onDelSess, core, onPublish, live, hostName, onHostName, onGoLive, onEndLive }) {',
     'SessionDetail signature')

sub1("""            {session.equipment && <span className="chip" style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{session.equipment}</span>}
          </div>
""",
     """            {session.equipment && <span className="chip" style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{session.equipment}</span>}
          </div>

          <HostRelayCard core={core} live={live} hostName={hostName}
            onHostName={onHostName} onGoLive={onGoLive} onEndLive={onEndLive}/>
""",
     'chips block')

# ─────────────────────────────────────────────────────── 4. App state + logic
sub1("  const [syncCfg, setSyncCfg] = useState(null);",
     """  const [syncCfg, setSyncCfg] = useState(null);
  // Live relay (pair fire). Which local session is being mirrored lives HERE,
  // not in SessionDetail, so navigating away from the session does not
  // silently drop the relay or start mirroring a different session's shots.
  const [liveSess, setLiveSess] = useState(null);
  const [relayName, setRelayName] = useState('');
  const [showJoin, setShowJoin] = useState(false);""",
     'App state')

sub1("      try { const r = await window.storage.get(SYNC_CFG_KEY); if (r) setSyncCfg(JSON.parse(r.value)); } catch {}",
     """      try { const r = await window.storage.get(SYNC_CFG_KEY); if (r) setSyncCfg(JSON.parse(r.value)); } catch {}
      try { const r = await window.storage.get('relay_name_v1'); if (r) setRelayName(JSON.parse(r.value)); } catch {}""",
     'App load')

sub1("""  const saveSyncCfg = async data => {
    setSyncCfg(data);
    try { await window.storage.set(SYNC_CFG_KEY, JSON.stringify(data)); } catch {}
  };
""",
     """  const saveSyncCfg = async data => {
    setSyncCfg(data);
    try { await window.storage.set(SYNC_CFG_KEY, JSON.stringify(data)); } catch {}
  };
  const saveRelayName = async data => {
    setRelayName(data);
    try { await window.storage.set('relay_name_v1', JSON.stringify(data)); } catch {}
  };
""",
     'saveSyncCfg')

sub1("""  const importRef = useRef(null);
""",
     """  // A relay can end without the host tapping "end": it expires, or going live
  // from a second session ends the first. The server's view wins.
  useEffect(() => {
    if (!core) return undefined;
    return core.on(core.EVENTS.RELAY_ENDED, () => setLiveSess(null));
  }, [core]);

  const goLive = async (sess, tgt, name) => {
    if (!core) return { ok: false, error: 'no backend configured' };
    const r = await core.createRelay({
      hostName: name,
      title: sess.name || sess.rangeLocation || null,
      targetName: tgt?.name || null,
      distanceYd: +sess.rangeYards || null,
    });
    if (!r.ok) return r;
    setLiveSess(sess.id);
    // Backfill the string already fired. A shooter who goes live mid-session
    // should not present an empty target to the coach who just joined.
    const prior = sess.shots || [];
    prior.forEach((sh, i) => core.relayPushShot({
      shotNo: prior.slice(0, i).filter(x => !!x.isSighter === !!sh.isSighter).length + 1,
      ring: sh.ring, isSighter: !!sh.isSighter, ...shotXY(sh, tgt),
    }));
    return r;
  };

  const endLive = async () => { setLiveSess(null); if (core) await core.endRelay(); };

  // Mirror one newly logged shot. Fire and forget by design: the local session
  // is the system of record, and a dead network must never block logging.
  const mirrorShot = (sess, tgt, sh) => {
    if (!core || liveSess !== sess.id) return;
    const prior = sess.shots || [];
    core.relayPushShot({
      shotNo: prior.filter(x => !!x.isSighter === !!sh.isSighter).length + 1,
      ring: sh.ring, isSighter: !!sh.isSighter, ...shotXY(sh, tgt),
    });
  };

  const importRef = useRef(null);
""",
     'importRef')

# ───────────────────────────────────────────────────────── 5. screen routing
sub1("""  if (screen === 'new_match') {""",
     """  if (screen === 'relay') {
    return <RelayViewer core={core} onExit={()=>setScreen('home')}/>;
  }

  if (screen === 'new_match') {""",
     'relay route')

sub1("""      onAddShot={sh=>{ const u=sessions.map(s=>s.id===sess.id?{...s,shots:[...(s.shots||[]),sh]}:s); saveSessions(u); }}""",
     """      onAddShot={sh=>{ const u=sessions.map(s=>s.id===sess.id?{...s,shots:[...(s.shots||[]),sh]}:s); saveSessions(u); mirrorShot(sess, tgt, sh); }}""",
     'onAddShot')

sub1("""      onDelSess={()=>{ saveSessions(sessions.filter(s=>s.id!==sess.id)); setScreen('home'); setActiveSess(null); }}
      core={core}""",
     """      onDelSess={()=>{ if (liveSess===sess.id) endLive(); saveSessions(sessions.filter(s=>s.id!==sess.id)); setScreen('home'); setActiveSess(null); }}
      core={core}
      live={liveSess === sess.id}
      hostName={relayName}
      onHostName={saveRelayName}
      onGoLive={name => goLive(sess, tgt, name)}
      onEndLive={endLive}""",
     'SessionDetail props')

# ──────────────────────────────────────────────────── 6. home screen entries
sub1("""              <button className="badd" style={{background:'none',border:'1px solid var(--bdr)',color:'var(--ink)'}} onClick={()=>setScreen('new_match')}>+ match</button>""",
     """              {core && <button className="badd" style={{background:'none',border:'1px solid var(--bdr)',color: showJoin ? 'var(--acc)' : 'var(--ink)'}} onClick={()=>setShowJoin(v=>!v)}>● join</button>}
              <button className="badd" style={{background:'none',border:'1px solid var(--bdr)',color:'var(--ink)'}} onClick={()=>setScreen('new_match')}>+ match</button>""",
     'home header')

sub1("""              <SessionsList
                sessions={sessions}""",
     """              {showJoin && core && (
                <JoinLiveForm core={core}
                  onCancel={()=>setShowJoin(false)}
                  onJoined={()=>{ setShowJoin(false); setScreen('relay'); }}/>
              )}
              {liveSess && sessions.some(s=>s.id===liveSess) && (
                <div className="tcard" style={{padding:'9px 13px',borderColor:'var(--green)',cursor:'pointer'}}
                  onClick={()=>{ setActiveSess(liveSess); setScreen('detail'); }}>
                  <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--green)'}}>
                    ● live · {core?.relayInfo()?.code} — tap to return to the session
                  </div>
                </div>
              )}
              <SessionsList
                sessions={sessions}""",
     'home list')

io.open(P, 'w', encoding='utf-8').write(src)
print('wired:', len(src.splitlines()), 'lines')
