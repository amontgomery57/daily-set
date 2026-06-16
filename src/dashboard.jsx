import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';

// ---- soft gate (change this to whatever you like) ----
const DASH_PASSWORD = 'setsquared';

// ---- Supabase (same public read-only key the game ships) ----
const SB_URL = 'https://ncujnlnlgzfxurlyfnzk.supabase.co';
const SB_KEY = 'sb_publishable_xD3sBJnHJ03O7Bv8xt1H9A_SXE8H6oL';
async function sb(path) {
  const r = await fetch(SB_URL + '/rest/v1' + path, {
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
  });
  if (!r.ok) throw new Error('Supabase ' + r.status);
  return r.json();
}

// ---- SET constants + deterministic generator (verbatim from the game) ----
const COLORS = { purple: '#6B2D8C', green: '#1B8B3A', red: '#C9252D' };
const COLOR_KEYS = ['purple', 'green', 'red'];
const SHAPES = ['oval', 'diamond', 'squiggle'];
const SHADINGS = ['solid', 'striped', 'open'];
const NUMBERS = [1, 2, 3];
const PUZZLE_VERSION = '1';
function generateDeck() {
  const d = [];
  for (const c of COLOR_KEYS) for (const s of SHAPES) for (const sh of SHADINGS) for (const n of NUMBERS)
    d.push({ color: c, shape: s, shading: sh, number: n });
  return d;
}
function isSet(a, b, c) {
  for (const at of ['color', 'shape', 'shading', 'number'])
    if (new Set([a[at], b[at], c[at]]).size === 2) return false;
  return true;
}
function findAllSets(cards) {
  const s = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) for (let k = j + 1; k < cards.length; k++)
    if (isSet(cards[i], cards[j], cards[k])) s.push([i, j, k]);
  return s;
}
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function generateDailyPuzzle(dateKey) {
  const deck = generateDeck();
  let best = null, bestDiff = Infinity;
  for (let attempt = 0; attempt < 3000; attempt++) {
    const rand = mulberry32(hashString(`${PUZZLE_VERSION}:${dateKey}:${attempt}`));
    const cards = seededShuffle(deck, rand).slice(0, 12);
    const sets = findAllSets(cards);
    if (sets.length === 6) return { cards, sets, dateKey };
    const diff = Math.abs(sets.length - 6);
    if (diff < bestDiff) { bestDiff = diff; best = { cards, sets, dateKey }; }
  }
  return best;
}

const fmt = (s) => { const x = typeof s === 'number' && isFinite(s) ? s : 0; const m = Math.floor(x / 60); return m + ':' + (x - m * 60).toFixed(2).padStart(5, '0'); };
const ATTRS = ['color', 'shape', 'shading', 'number'];
const maskLabel = (m) => { const diff = ATTRS.filter((_, i) => m[i] === '1'); return diff.length === 4 ? 'all differ' : 'same ' + ATTRS.filter((_, i) => m[i] === '0').join('+'); };
const popcount = (m) => m.split('').filter((c) => c === '1').length;
const SET_RING = ['#b91c1c', '#1B8B3A', '#6B2D8C', '#d97706', '#0891b2', '#db2777'];

function Shape({ shape, color, shading }) {
  const hex = COLORS[color];
  const fill = shading === 'solid' ? hex : shading === 'open' ? 'white' : `url(#st-${color})`;
  return (
    <svg viewBox="0 0 50 100" preserveAspectRatio="xMidYMid meet">
      {shape === 'oval' && <rect x="4" y="8" width="42" height="84" rx="21" ry="21" fill={fill} stroke={hex} strokeWidth="3" />}
      {shape === 'diamond' && <polygon points="25,5 47,50 25,95 3,50" fill={fill} stroke={hex} strokeWidth="3" strokeLinejoin="round" />}
      {shape === 'squiggle' && <path d="M 10 12 C 22 4,36 8,42 18 C 47 28,32 36,28 46 C 24 56,42 60,44 72 C 46 86,32 96,18 92 C 6 88,4 76,10 66 C 16 56,24 50,22 40 C 20 30,6 28,8 18 C 8 14,9 13,10 12 Z" fill={fill} stroke={hex} strokeWidth="3" strokeLinejoin="round" />}
    </svg>
  );
}
function Card({ card, ring }) {
  return (
    <div className="gc" style={ring ? { borderColor: ring, boxShadow: `0 0 0 2px ${ring}55` } : null}>
      {Array(card.number).fill(0).map((_, i) => <Shape key={i} {...card} />)}
    </div>
  );
}
function Defs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }}><defs>{COLOR_KEYS.map((c) => (
      <pattern key={c} id={`st-${c}`} patternUnits="userSpaceOnUse" width="5" height="5">
        <rect width="5" height="5" fill="white" /><line x1="0" y1="0" x2="0" y2="5" stroke={COLORS[c]} strokeWidth="1.8" />
      </pattern>
    ))}</defs></svg>
  );
}

function analyze(rows) {
  const players = {};
  for (const r of rows) {
    const p = players[r.name] || (players[r.name] = { name: r.name, times: [], splits: 0 });
    p.times.push(Number(r.time_seconds));
    if (r.splits) p.splits++;
  }
  const leaderboard = Object.values(players).map((p) => {
    const t = [...p.times].sort((a, b) => a - b);
    const med = t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;
    return { name: p.name, solves: p.times.length, withSplits: p.splits,
      avg: p.times.reduce((s, x) => s + x, 0) / p.times.length, best: Math.min(...p.times), median: med };
  }).sort((a, b) => b.solves - a.solves);

  const splitPlayers = {};
  for (const r of rows) {
    if (!r.splits) continue;
    const sp = splitPlayers[r.name] || (splitPlayers[r.name] = {
      name: r.name, gaps: [[], [], [], [], [], []], ordCnt: [0, 0, 0, 0, 0, 0], allDiffByOrd: [0, 0, 0, 0, 0, 0],
      attrSameOrd: { color: [], shape: [], shading: [], number: [] }, attrVaryOrd: { color: [], shape: [], shading: [], number: [] }, ctrlGaps: [],
    });
    let prev = 0, allDiff = [], other = [];
    r.splits.forEach((e, i) => {
      const gap = e.t - prev; prev = e.t;
      if (i < 6) { sp.gaps[i].push(gap); sp.ordCnt[i]++; if (e.mask === '1111') sp.allDiffByOrd[i]++; }
      ATTRS.forEach((a, ai) => { (e.mask[ai] === '0' ? sp.attrSameOrd : sp.attrVaryOrd)[a].push(i + 1); });
      if (e.mask === '1111') allDiff.push(i + 1); else other.push(i + 1);
    });
    if (allDiff.length && other.length) {
      sp.ctrlGaps.push(allDiff.reduce((x, y) => x + y, 0) / allDiff.length - other.reduce((x, y) => x + y, 0) / other.length);
    }
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const splitStats = Object.values(splitPlayers).map((sp) => ({
    name: sp.name, n: sp.ordCnt[0],
    avgGap: sp.gaps.map((g) => mean(g)),
    allDiffRate: sp.allDiffByOrd.map((c, i) => (sp.ordCnt[i] ? c / sp.ordCnt[i] : 0)),
    salience: ATTRS.map((a) => ({ attr: a, delta: (mean(sp.attrVaryOrd[a]) || 0) - (mean(sp.attrSameOrd[a]) || 0) })),
    ctrlGap: mean(sp.ctrlGaps), ctrlN: sp.ctrlGaps.length,
  })).filter((s) => s.n >= 10).sort((a, b) => b.n - a.n);

  return {
    leaderboard, splitStats, total: rows.length, withSplits: rows.filter((r) => r.splits).length,
    players: leaderboard.length, dates: new Set(rows.map((r) => r.date)).size,
    first: rows.reduce((m, r) => (r.date < m ? r.date : m), '9999'), last: rows.reduce((m, r) => (r.date > m ? r.date : m), '0000'),
  };
}

function Bars({ stats }) {
  const players = stats.slice(0, 2);
  const maxv = Math.max(...players.flatMap((p) => p.avgGap.filter((x) => x != null)), 1);
  const colors = ['#b91c1c', '#d6c4c0'];
  return (
    <div>
      <div className="legend">{players.map((p, i) => <span key={p.name}><i className="dot" style={{ background: colors[i] }} />{p.name}</span>)}</div>
      <div className="chart">{[0, 1, 2, 3, 4, 5].map((k) => (
        <div className="col" key={k}>
          <div className="pair">{players.map((p, i) => {
            const v = p.avgGap[k] || 0;
            return (
              <div key={p.name} className="bar" style={{ height: `${Math.max(2, (v / maxv) * 120)}px`, background: colors[i] }}>
                <span className="v" style={{ color: i === 0 ? '#b91c1c' : '#9c7b74' }}>{v.toFixed(1)}</span>
              </div>
            );
          })}</div>
          <div className="xl">{['1st', '2nd', '3rd', '4th', '5th', '6th'][k]}</div>
        </div>
      ))}</div>
    </div>
  );
}

function Findings({ a }) {
  return (
    <div>
      <div className="card"><h2>Overview</h2>
        <div className="statrow">
          <div className="stat"><div className="v">{a.total}</div><div className="l">solves</div></div>
          <div className="stat"><div className="v">{a.withSplits}</div><div className="l">with splits</div></div>
          <div className="stat"><div className="v">{a.players}</div><div className="l">players</div></div>
          <div className="stat"><div className="v">{a.dates}</div><div className="l">dates</div></div>
        </div>
        <div className="note">{a.first} → {a.last}</div>
      </div>

      <div className="card"><h2>Seconds to find each set · top split players</h2>
        {a.splitStats.length ? <Bars stats={a.splitStats} /> : <div className="muted">No split data yet.</div>}
        <div className="note">The last set typically dwarfs the first few — total time is mostly the final-set hunt.</div>
      </div>

      {a.splitStats.slice(0, 1).map((sp) => {
        const maxd = Math.max(...sp.salience.map((z) => Math.abs(z.delta)), 0.01);
        return (
          <div className="card" key={sp.name}><h2>What pops out · {sp.name} (n={sp.n})</h2>
            <div className="muted" style={{ marginBottom: 4 }}>How much earlier a set is found when it <b>shares</b> an attribute (order slots):</div>
            {[...sp.salience].sort((x, y) => y.delta - x.delta).map((s) => (
              <div className="attr" key={s.attr}>
                <span className="lab">{s.attr}</span>
                <span className="track"><span className="fill" style={{ width: `${(Math.max(0, s.delta) / maxd) * 100}%` }} /></span>
                <span className="pct mono">{s.delta.toFixed(2)}</span>
              </div>
            ))}
            <div className="note">All-different sets found later than co-resident sets: <b>+{sp.ctrlGap ? sp.ctrlGap.toFixed(2) : '—'}</b> order slots (within-puzzle, n={sp.ctrlN} solves).</div>
          </div>
        );
      })}

      <div className="card"><h2>All-different rate by find order</h2>
        <table><thead><tr><th>Player</th><th className="r">1st</th><th className="r">2nd</th><th className="r">3rd</th><th className="r">4th</th><th className="r">5th</th><th className="r">6th</th></tr></thead>
          <tbody>{a.splitStats.map((sp) => (
            <tr key={sp.name}><td>{sp.name}</td>{sp.allDiffRate.map((r, i) => <td className="r mono" key={i}>{(r * 100).toFixed(0)}%</td>)}</tr>
          ))}</tbody></table>
        <div className="note">Rises left→right: the hardest (all-attributes-differ) sets are found last.</div>
      </div>

      <div className="card"><h2>Leaderboard</h2>
        <table><thead><tr><th>Player</th><th className="r">Solves</th><th className="r">Avg</th><th className="r">Best</th><th className="r">Median</th></tr></thead>
          <tbody>{a.leaderboard.map((p) => (
            <tr key={p.name}><td>{p.name}</td><td className="r mono">{p.solves}</td>
              <td className="r mono">{fmt(p.avg)}</td><td className="r mono">{fmt(p.best)}</td><td className="r mono">{fmt(p.median)}</td></tr>
          ))}</tbody></table>
      </div>
    </div>
  );
}

function SolveDetail({ row }) {
  const pz = useMemo(() => { try { return generateDailyPuzzle(row.date); } catch { return null; } }, [row.date]);
  if (!pz) return <div className="muted">Could not regenerate this puzzle.</div>;
  const ringByCard = {};
  row.splits.forEach((e, i) => { (e.idx || []).forEach((ci) => { if (ringByCard[ci] === undefined) ringByCard[ci] = SET_RING[i % SET_RING.length]; }); });
  let prev = 0;
  return (
    <div style={{ padding: '8px 2px' }}>
      <Defs />
      <div className="board">{pz.cards.map((c, ci) => <Card key={ci} card={c} ring={ringByCard[ci]} />)}</div>
      <div style={{ marginTop: 6 }}>{row.splits.map((e, i) => {
        const gap = e.t - prev; prev = e.t;
        return (
          <span className="setpill" key={i}>
            <i className="dot" style={{ background: SET_RING[i % SET_RING.length] }} />
            #{i + 1} · {maskLabel(e.mask)} · <span className="mono">{e.t.toFixed(1)}s</span>
            <span className="muted">(+{gap.toFixed(1)})</span>
          </span>
        );
      })}</div>
      <div className="note">Rings show find order; pills give each set's type, cumulative time, and gap from the previous set.</div>
    </div>
  );
}

function Explorer({ rows }) {
  const names = useMemo(() => ['all', ...Array.from(new Set(rows.map((r) => r.name)))], [rows]);
  const [who, setWho] = useState('all');
  const [open, setOpen] = useState(null);
  const filtered = useMemo(() => rows.filter((r) => who === 'all' || r.name === who).slice(0, 300), [rows, who]);
  return (
    <div className="card"><h2>Raw solves</h2>
      <div style={{ marginBottom: 10 }}>
        <select value={who} onChange={(e) => { setWho(e.target.value); setOpen(null); }}>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="muted" style={{ marginLeft: 8 }}>{filtered.length} shown</span>
      </div>
      <table><thead><tr><th>Date</th><th>Player</th><th className="r">Time</th><th className="r">Sets logged</th></tr></thead>
        <tbody>{filtered.map((r, i) => {
          const key = r.date + '|' + r.name + '|' + i;
          return (
            <React.Fragment key={key}>
              <tr className="solverow" onClick={() => setOpen(open === key ? null : key)}>
                <td className="mono">{r.date}</td><td>{r.name}</td>
                <td className="r mono">{fmt(Number(r.time_seconds))}</td>
                <td className="r">{r.splits ? r.splits.length : '—'}{r.splits ? (open === key ? ' ▾' : ' ›') : ''}</td>
              </tr>
              {open === key && r.splits && <tr><td colSpan="4" style={{ background: '#faf9f7' }}><SolveDetail row={r} /></td></tr>}
            </React.Fragment>
          );
        })}</tbody></table>
    </div>
  );
}

function Dashboard() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('findings');
  const [stamp, setStamp] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setErr(null);
    try {
      const data = await sb('/results?select=date,name,time_seconds,splits&order=date.desc&limit=10000');
      setRows(data); setStamp(new Date());
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, []);
  const a = useMemo(() => (rows ? analyze(rows) : null), [rows]);
  return (
    <div className="wrap">
      <div className="topbar">
        <div><div className="kicker">Daily SET · live dashboard</div><h1>Player &amp; solve analytics</h1></div>
        <div style={{ textAlign: 'right' }}>
          <button className="btn sm" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : '↻ Refresh'}</button>
          <div className="stamp">{stamp ? 'updated ' + stamp.toLocaleTimeString() : 'loading…'}{' · auto every 30s'}</div>
        </div>
      </div>
      {err && <div className="card"><div className="err">Couldn't load data: {err}</div></div>}
      {!rows && !err && <div className="card"><div className="muted">Loading live data…</div></div>}
      {a && (
        <>
          <div className="tabs">
            <button className={tab === 'findings' ? 'on' : ''} onClick={() => setTab('findings')}>Findings</button>
            <button className={tab === 'explorer' ? 'on' : ''} onClick={() => setTab('explorer')}>Raw explorer</button>
          </div>
          {tab === 'findings' ? <Findings a={a} /> : <Explorer rows={rows} />}
          <div className="note" style={{ textAlign: 'center' }}>Live read from Supabase · soft-gated page, data is read-only.</div>
        </>
      )}
    </div>
  );
}

function Gate() {
  const [val, setVal] = useState('');
  const [ok, setOk] = useState(() => sessionStorage.getItem('dash_ok') === '1');
  const [bad, setBad] = useState(false);
  const submit = () => { if (val === DASH_PASSWORD) { sessionStorage.setItem('dash_ok', '1'); setOk(true); } else setBad(true); };
  if (ok) return <Dashboard />;
  return (
    <div className="gate"><div className="gatebox">
      <div className="kicker">Daily SET</div>
      <h1 style={{ fontSize: 20, margin: '6px 0 2px' }}>Dashboard</h1>
      <div className="muted">Enter the password to view live analytics.</div>
      <input type="password" autoFocus value={val} placeholder="password"
        onChange={(e) => { setVal(e.target.value); setBad(false); }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      {bad && <div className="err">Incorrect password.</div>}
      <button className="btn" style={{ width: '100%' }} onClick={submit}>Enter</button>
    </div></div>
  );
}

createRoot(document.getElementById('root')).render(<Gate />);
