const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'goals.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const SESSION_PASSWORD = process.env.SESSION_PASSWORD || 'takeaction';

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth') || req.path === '/api/status') return next();
  if (req.headers.authorization === SESSION_PASSWORD || req.query.pwd === SESSION_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

app.get('/api/auth/check', (req, res) => {
  req.query.pwd === SESSION_PASSWORD
    ? res.json({ ok: true })
    : res.status(401).json({ ok: false });
});

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    priority TEXT,
    category TEXT,
    description TEXT,
    metric TEXT,
    kpi REAL,
    unit TEXT,
    lower_is_better INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER REFERENCES goals(id),
    date TEXT NOT NULL,
    value REAL NOT NULL,
    logged_at TEXT DEFAULT (datetime('now')),
    UNIQUE(goal_id, date)
  );
  CREATE TABLE IF NOT EXISTS daily_notes (
    date TEXT PRIMARY KEY,
    note TEXT DEFAULT '',
    emojis TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6ea8ff',
    notes TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS surf_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    quality REAL,
    wave_size TEXT DEFAULT '',
    tide TEXT DEFAULT '',
    swell_direction TEXT DEFAULT '',
    swell_secondary TEXT DEFAULT '',
    location TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    surfboard TEXT DEFAULT '',
    wind TEXT DEFAULT '',
    texture TEXT DEFAULT '',
    time_start TEXT DEFAULT '',
    time_end TEXT DEFAULT ''
  );
`);

// Cumulative goals (SUM for YTD): Savings, Surf, Reading, Surf Sessions
const CUMULATIVE_GOALS   = [1, 3, 9, 13];
// Average goals (AVG of logged entries): Screen Time, Exercise
const AVERAGE_GOALS      = [2, 6];
// Weekly sum/count goals (total / weeks elapsed): Work, Family, Friends, Stretching, Alcohol
const WEEKLY_COUNT_GOALS = [4, 7, 8, 10, 11];

// ─── SEED ─────────────────────────────────────────────────────────────────────
function seedIfEmpty() {
  const seedPath = path.join(__dirname, 'db-export.json');
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch (e) {
    console.log('[seed] no db-export.json, skipping');
    return;
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM goals').get().n;
  if (count > 0) {
    // Always sync lower_is_better flags from seed (source of truth)
    const upd = db.prepare('UPDATE goals SET lower_is_better = ? WHERE id = ?');
    seed.goals.forEach(g => upd.run(g.lower_is_better || 0, g.id));
    console.log(`[seed] DB has ${count} goals, flags synced`);
    return;
  }

  console.log('[seed] DB empty, seeding from db-export.json');
  const insertGoal = db.prepare(`INSERT INTO goals
    (id, name, priority, category, description, metric, kpi, unit, lower_is_better)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertLog  = db.prepare(`INSERT INTO daily_logs (goal_id, date, value) VALUES (?,?,?)`);
  const insertNote = db.prepare(`INSERT INTO daily_notes (date, note) VALUES (?,?)`);

  db.transaction(() => {
    seed.goals.forEach(g => insertGoal.run(
      g.id, g.name, g.priority, g.category, g.description, g.metric, g.kpi, g.unit, g.lower_is_better || 0
    ));
    (seed.logs  || []).forEach(l => insertLog.run(l.goal_id, l.date, l.value));
    (seed.notes || []).forEach(n => insertNote.run(n.date, n.note));
  })();

  console.log(`[seed] Done — ${seed.goals.length} goals, ${(seed.logs||[]).length} logs, ${(seed.notes||[]).length} notes`);
}

seedIfEmpty();

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Public status — no auth
app.get('/api/status', (req, res) => {
  try {
    const logs  = db.prepare('SELECT COUNT(*) AS n FROM daily_logs').get().n;
    const goals = db.prepare('SELECT COUNT(*) AS n FROM goals').get().n;
    res.json({ db: 'ok', goals, logs });
  } catch (e) {
    res.json({ db: 'error', error: e.message });
  }
});

// GET all goals
app.get('/api/goals', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM goals ORDER BY id').all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET full trends data (monthly, quarterly, weekly) for a goal
app.get('/api/logs/trends/:goalId', (req, res) => {
  try {
    const goalId = parseInt(req.params.goalId);
    const year   = new Date().getFullYear();
    const today  = new Date().toISOString().slice(0, 10);

    const rows = db.prepare(
      'SELECT date, value FROM daily_logs WHERE goal_id = ? AND date >= ? AND date <= ? ORDER BY date ASC'
    ).all(goalId, `${year}-01-01`, today);

    let sessionRows = null;
    if (goalId === 3) {
      sessionRows = db.prepare(
        'SELECT date, value FROM daily_logs WHERE goal_id = 13 AND date >= ? AND date <= ? ORDER BY date ASC'
      ).all(`${year}-01-01`, today);
    }

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const todayMs = new Date(today).getTime();

    function elapsedInPeriod(startStr, endStr) {
      const start = new Date(startStr).getTime();
      const end   = new Date(endStr).getTime();
      if (todayMs < start) return 0;
      return Math.floor((Math.min(todayMs, end) - start) / 86400000) + 1;
    }

    const monthly = MONTH_NAMES.map((label, i) => {
      const mo  = String(i + 1).padStart(2, '0');
      const mR  = rows.filter(r => r.date.slice(5, 7) === mo);
      const total    = mR.reduce((s, r) => s + parseFloat(r.value), 0);
      const count    = mR.length;
      const sessions = sessionRows
        ? sessionRows.filter(r => r.date.slice(5, 7) === mo).reduce((s, r) => s + parseFloat(r.value), 0)
        : mR.filter(r => parseFloat(r.value) > 0).length;
      const avg         = count > 0 ? total / count : 0;
      const periodDays  = new Date(year, i + 1, 0).getDate();
      const lastDay     = String(periodDays).padStart(2, '0');
      const elapsedDays = elapsedInPeriod(`${year}-${mo}-01`, `${year}-${mo}-${lastDay}`);
      return { label, total: +total.toFixed(3), avg: +avg.toFixed(3), count, sessions, periodDays, elapsedDays };
    });

    const quarterly = [
      { label: 'Q1', mos: ['01','02','03'], months: [0,1,2], start: `${year}-01-01` },
      { label: 'Q2', mos: ['04','05','06'], months: [3,4,5], start: `${year}-04-01` },
      { label: 'Q3', mos: ['07','08','09'], months: [6,7,8], start: `${year}-07-01` },
      { label: 'Q4', mos: ['10','11','12'], months: [9,10,11], start: `${year}-10-01` },
    ].map(q => {
      const qR       = rows.filter(r => q.mos.includes(r.date.slice(5, 7)));
      const total    = qR.reduce((s, r) => s + parseFloat(r.value), 0);
      const count    = qR.length;
      const sessions = sessionRows
        ? sessionRows.filter(r => q.mos.includes(r.date.slice(5, 7))).reduce((s, r) => s + parseFloat(r.value), 0)
        : qR.filter(r => parseFloat(r.value) > 0).length;
      const avg         = count > 0 ? total / count : 0;
      const periodDays  = q.months.reduce((s, m) => s + new Date(year, m + 1, 0).getDate(), 0);
      const lastMo      = q.mos[2];
      const lastDay     = String(new Date(year, q.months[2] + 1, 0).getDate()).padStart(2, '0');
      const elapsedDays = elapsedInPeriod(q.start, `${year}-${lastMo}-${lastDay}`);
      return { label: q.label, total: +total.toFixed(3), avg: +avg.toFixed(3), count, sessions, periodDays, elapsedDays };
    });

    function mondayOf(ds) {
      const [y, mo, d] = ds.split('-').map(Number);
      const dt  = new Date(y, mo - 1, d);
      const dow = dt.getDay();
      const diff = dow === 0 ? -6 : 1 - dow;
      const mon  = new Date(y, mo - 1, d + diff);
      return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
    }
    function addWeeks(ds, n) {
      const [y, mo, d] = ds.split('-').map(Number);
      const dt = new Date(y, mo - 1, d + n * 7);
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
    }

    const weekMap = {};
    rows.forEach(r => {
      const ws = mondayOf(r.date);
      if (!weekMap[ws]) weekMap[ws] = { total: 0, count: 0, sessions: 0 };
      weekMap[ws].total += parseFloat(r.value);
      weekMap[ws].count += 1;
      if (!sessionRows && parseFloat(r.value) > 0) weekMap[ws].sessions += 1;
    });
    if (sessionRows) {
      sessionRows.forEach(r => {
        const ws = mondayOf(r.date);
        if (!weekMap[ws]) weekMap[ws] = { total: 0, count: 0, sessions: 0 };
        weekMap[ws].sessions += parseFloat(r.value);
      });
    }

    let cur = mondayOf(`${year}-01-01`);
    const todayWs = mondayOf(today);
    const weeks = [];
    let cumulative = 0, cumSessions = 0, wNum = 1;
    while (cur <= todayWs) {
      const data = weekMap[cur] || { total: 0, count: 0, sessions: 0 };
      cumulative  += data.total;
      cumSessions += data.sessions;
      weeks.push({
        label: `W${wNum}`, total: +data.total.toFixed(3),
        avg: data.count > 0 ? +(data.total/data.count).toFixed(3) : 0,
        count: data.count, sessions: data.sessions,
        cumulative: +cumulative.toFixed(3), cumSessions
      });
      cur = addWeeks(cur, 1);
      wNum++;
    }

    res.json({ monthly, quarterly, weekly: weeks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET monthly breakdown for a single goal
app.get('/api/logs/yearly/:goalId', (req, res) => {
  try {
    const goalId = parseInt(req.params.goalId);
    const year   = new Date().getFullYear();
    const currentMonth = new Date().getMonth();

    const rows = db.prepare(
      'SELECT date, value FROM daily_logs WHERE goal_id = ? AND date >= ? AND date <= ? ORDER BY date ASC'
    ).all(goalId, `${year}-01-01`, `${year}-12-31`);

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthTotals = new Array(12).fill(0);
    rows.forEach(r => {
      const m = parseInt(r.date.split('-')[1]) - 1;
      monthTotals[m] += parseFloat(r.value);
    });

    let cumulative = 0;
    const result = [];
    for (let i = 0; i <= currentMonth; i++) {
      cumulative += monthTotals[i];
      result.push({ month: MONTHS[i], monthTotal: Math.round(monthTotals[i]), cumulative: Math.round(cumulative) });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET aggregated YTD dashboard data
app.get('/api/logs', (req, res) => {
  try {
    const goals = db.prepare('SELECT * FROM goals ORDER BY id').all();
    const now       = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const today     = now.toISOString().slice(0, 10);
    const result    = [];
    const stmt = db.prepare(
      'SELECT date, value FROM daily_logs WHERE goal_id = ? AND date >= ? AND date <= ? ORDER BY date ASC'
    );

    for (const g of goals) {
      if (g.id === 12) continue;
      const rows = stmt.all(g.id, yearStart, today);
      if (rows.length === 0) continue;

      const vals = rows.map(r => parseFloat(r.value));
      let value;

      if (g.id === 5) {
        value = vals[vals.length - 1];
      } else if (CUMULATIVE_GOALS.includes(g.id)) {
        value = vals.reduce((s, v) => s + v, 0);
      } else if (AVERAGE_GOALS.includes(g.id)) {
        value = vals.reduce((s, v) => s + v, 0) / vals.length;
      } else if (WEEKLY_COUNT_GOALS.includes(g.id)) {
        const total = vals.reduce((s, v) => s + v, 0);
        const weeksElapsed = Math.max(1, Math.floor(
          (now - new Date(now.getFullYear(), 0, 1)) / (7 * 86400000)
        ));
        value = total / weeksElapsed;
      } else {
        value = vals[vals.length - 1];
      }

      const entry = { goal_id: g.id, value: parseFloat(value.toFixed(2)), date: rows[rows.length - 1].date };
      if (g.id === 6) entry.days = vals.filter(v => v > 0).length;
      result.push(entry);
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET all daily logs for a specific month (YYYY-MM)
app.get('/api/logs/monthly', (req, res) => {
  try {
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: 'month param required' });
    const rows = db.prepare(
      "SELECT goal_id, date, value FROM daily_logs WHERE date LIKE ? ORDER BY date ASC"
    ).all(`${month}%`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST save daily logs
app.post('/api/log/daily', (req, res) => {
  try {
    const { entries = [], deletions = [] } = req.body;
    const ins = db.prepare(`INSERT INTO daily_logs (goal_id, date, value)
      VALUES (?, ?, ?)
      ON CONFLICT(goal_id, date) DO UPDATE SET value = excluded.value, logged_at = datetime('now')`);
    const del = db.prepare('DELETE FROM daily_logs WHERE goal_id = ? AND date = ?');
    db.transaction(() => {
      entries.forEach(e => {
        if (e.value !== null && e.value !== undefined && e.value !== '') {
          ins.run(e.goal_id, e.date, parseFloat(e.value));
        }
      });
      deletions.forEach(d => del.run(d.goal_id, d.date));
    })();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET meta (week, day, market data)
app.get('/api/meta', async (req, res) => {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now - startOfYear) / 86400000) + 1;
  const week = Math.ceil(dayOfYear / 7);
  const pctOfYear = ((dayOfYear / 365) * 100).toFixed(1);

  let market = { sp500: '—', vti: '—' };
  try {
    const yr  = now.getFullYear();
    const d1  = `${yr}0101`;
    const d2  = `${yr}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    function ytdFromCsv(csv) {
      const rows = csv.trim().split('\n').slice(1)
        .filter(r => r.includes(','))
        .map(r => parseFloat(r.split(',')[4]))
        .filter(v => !isNaN(v));
      if (rows.length < 2) return null;
      return (((rows[rows.length-1] - rows[0]) / rows[0]) * 100).toFixed(2);
    }
    const fetchWithTimeout = (url, ms = 5000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      return fetch(url, { signal: ctrl.signal })
        .then(r => { clearTimeout(timer); return r; })
        .catch(() => { clearTimeout(timer); return null; });
    };
    const [spRes, vtiRes] = await Promise.all([
      fetchWithTimeout(`https://stooq.com/q/d/l/?s=%5Espx&d1=${d1}&d2=${d2}&i=d`),
      fetchWithTimeout(`https://stooq.com/q/d/l/?s=vti.us&d1=${d1}&d2=${d2}&i=d`),
    ]);
    if (spRes  && spRes.ok)  { const v = ytdFromCsv(await spRes.text());  if (v) market.sp500 = v; }
    if (vtiRes && vtiRes.ok) { const v = ytdFromCsv(await vtiRes.text()); if (v) market.vti   = v; }
  } catch (e) {}

  res.json({
    week, dayOfYear, pctOfYear,
    date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    market
  });
});

// GET year-view data for 2026
app.get('/api/year-view/2026', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        date,
        MAX(CASE WHEN goal_id = 6 THEN value END) AS exercise,
        MAX(CASE WHEN goal_id = 4 THEN value END) AS work,
        MAX(CASE WHEN goal_id = 2 THEN value END) AS screen_time,
        MAX(CASE WHEN goal_id = 3 THEN value END) AS surf,
        MAX(CASE WHEN goal_id = 9 THEN value END) AS reading
      FROM daily_logs
      WHERE date BETWEEN '2026-01-01' AND '2026-12-31'
        AND goal_id IN (2, 3, 4, 6, 9)
      GROUP BY date
    `).all();

    const noteRows = db.prepare(`SELECT date FROM daily_notes WHERE note != ''`).all();
    const noteSet = new Set(noteRows.map(n => n.date));

    const byDate = {};
    rows.forEach(r => {
      byDate[r.date] = {
        exercise:   r.exercise    !== null ? parseFloat(r.exercise)    : null,
        work:       r.work        !== null ? parseFloat(r.work)        : null,
        screenTime: r.screen_time !== null ? parseFloat(r.screen_time) : null,
        surf:       r.surf        !== null ? parseFloat(r.surf)        : null,
        reading:    r.reading     !== null ? parseFloat(r.reading)     : null,
        hasNote:    noteSet.has(r.date),
      };
    });
    noteSet.forEach(d => {
      if (!byDate[d]) byDate[d] = { exercise: null, work: null, screenTime: null, surf: null, reading: null, hasNote: true };
    });

    res.json(byDate);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET current streaks
app.get('/api/streaks', (req, res) => {
  try {
    const habitGoals = [
      { id: 6,  label: 'Exercise',     fn: v => v >= 1 },
      { id: 3,  label: 'Surf',         fn: v => v > 0 },
      { id: 10, label: 'Stretching',   fn: v => v > 0 },
      { id: 11, label: 'Alcohol-free', fn: v => v === 0, missingIsPass: true },
      { id: 2,  label: 'Screen time',  fn: v => v <= 1.5 },
    ];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const stmt = db.prepare(
      `SELECT date, value FROM daily_logs WHERE goal_id = ? AND date >= '2026-01-01' ORDER BY date DESC`
    );

    const results = [];
    for (const goal of habitGoals) {
      const rows = stmt.all(goal.id);
      const logMap = {};
      for (const row of rows) logMap[row.date] = parseFloat(row.value);

      let streak = 0;
      const start = new Date(today);
      if (!(todayStr in logMap) && !goal.missingIsPass) start.setDate(start.getDate() - 1);

      const cur = new Date(start);
      while (true) {
        const ds = cur.toISOString().split('T')[0];
        if (ds < '2026-01-01') break;
        const hasLog = ds in logMap;
        if (!hasLog && !goal.missingIsPass) break;
        if (hasLog && !goal.fn(logMap[ds])) break;
        streak++;
        cur.setDate(cur.getDate() - 1);
      }
      results.push({ id: goal.id, label: goal.label, streak });
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NOTES ────────────────────────────────────────────────────────────────────
app.get('/api/notes', (req, res) => {
  try {
    const rows = db.prepare(`SELECT date, note FROM daily_notes WHERE note != '' ORDER BY date ASC`).all();
    res.json({ notes: rows.map(r => ({ date: r.date, note: r.note })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes/exists', (req, res) => {
  try {
    const rows = db.prepare(`SELECT date FROM daily_notes WHERE note != '' ORDER BY date`).all();
    res.json({ dates: rows.map(r => r.date) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes/:date', (req, res) => {
  try {
    const row = db.prepare('SELECT note, emojis FROM daily_notes WHERE date = ?').get(req.params.date);
    res.json({ note: row ? row.note : '', emojis: row ? (row.emojis || '') : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notes', (req, res) => {
  try {
    const { date, note, emojis } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    db.prepare(`INSERT INTO daily_notes (date, note, emojis) VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET note = excluded.note, emojis = excluded.emojis`)
      .run(date, note || '', emojis || '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/emojis', (req, res) => {
  try {
    const rows = db.prepare(`SELECT date, emojis FROM daily_notes WHERE emojis != '' ORDER BY date`).all();
    const map = {};
    rows.forEach(r => { map[r.date] = r.emojis.split(',').filter(Boolean); });
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EVENTS ───────────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  try {
    res.json({ events: db.prepare(
      `SELECT id, name, start_date, end_date, color, notes FROM calendar_events ORDER BY start_date ASC`
    ).all() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events', (req, res) => {
  try {
    const { name, start_date, end_date, color, notes = '' } = req.body;
    if (!name || !start_date || !end_date || !color) return res.status(400).json({ error: 'Missing fields' });
    const row = db.prepare(
      `INSERT INTO calendar_events (name, start_date, end_date, color, notes) VALUES (?,?,?,?,?) RETURNING *`
    ).get(name, start_date, end_date, color, notes);
    res.json({ event: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/events/:id', (req, res) => {
  try {
    const { name, start_date, end_date, color, notes = '' } = req.body;
    if (!name || !start_date || !end_date || !color) return res.status(400).json({ error: 'Missing fields' });
    const row = db.prepare(
      `UPDATE calendar_events SET name=?, start_date=?, end_date=?, color=?, notes=? WHERE id=? RETURNING *`
    ).get(name, start_date, end_date, color, notes, req.params.id);
    res.json({ event: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/events/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SURF SESSIONS ────────────────────────────────────────────────────────────
app.get('/api/surf-sessions', (req, res) => {
  try {
    res.json(db.prepare(`SELECT * FROM surf_sessions ORDER BY date DESC, id DESC`).all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/surf-sessions/:date', (req, res) => {
  try {
    res.json(db.prepare(`SELECT * FROM surf_sessions WHERE date = ? ORDER BY id ASC`).all(req.params.date));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/surf-session', (req, res) => {
  try {
    const { date, quality, wave_size = '', tide = '', swell_direction = '', swell_secondary = '',
            location = '', notes = '', surfboard = '', wind = '', texture = '',
            time_start = '', time_end = '' } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    if (quality != null && (quality < 1 || quality > 4)) return res.status(400).json({ error: 'quality must be 1–4' });
    const r = db.prepare(
      `INSERT INTO surf_sessions
       (date, quality, wave_size, tide, swell_direction, swell_secondary, location, notes, surfboard, wind, texture, time_start, time_end)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(date, quality || null, wave_size, tide, swell_direction, swell_secondary, location, notes, surfboard, wind, texture, time_start, time_end);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/surf-session/:id', (req, res) => {
  try {
    const { quality, wave_size = '', tide = '', swell_direction = '', swell_secondary = '',
            location = '', notes = '', surfboard = '', wind = '', texture = '',
            time_start = '', time_end = '' } = req.body;
    if (quality != null && (quality < 1 || quality > 4)) return res.status(400).json({ error: 'quality must be 1–4' });
    db.prepare(
      `UPDATE surf_sessions SET quality=?, wave_size=?, tide=?, swell_direction=?, swell_secondary=?,
       location=?, notes=?, surfboard=?, wind=?, texture=?, time_start=?, time_end=?
       WHERE id=?`
    ).run(quality || null, wave_size, tide, swell_direction, swell_secondary, location, notes, surfboard, wind, texture, time_start, time_end, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/surf-session/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM surf_sessions WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Goals tracker running on http://localhost:${PORT}`));
