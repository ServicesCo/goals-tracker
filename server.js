const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const SESSION_PASSWORD = process.env.SESSION_PASSWORD || 'takeaction';

app.use((req, res, next) => {
  // Only protect API routes — static files are served openly (client-side JS handles login redirect)
  if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth') || req.path === '/api/status') return next();
  const authHeader = req.headers.authorization;
  if (authHeader === SESSION_PASSWORD || req.query.pwd === SESSION_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

app.get('/api/auth/check', (req, res) => {
  req.query.pwd === SESSION_PASSWORD
    ? res.json({ ok: true })
    : res.status(401).json({ ok: false });
});

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const query = (text, params) => pool.query(text, params);

// Cumulative goals (SUM for YTD): Savings, Surf, Reading, Surf Sessions
const CUMULATIVE_GOALS   = [1, 3, 9, 13];
// Average goals (AVG of logged entries): Screen Time, Exercise
const AVERAGE_GOALS      = [2, 6];
// Weekly sum/count goals (total / weeks elapsed): Work, Family, Friends, Stretching, Alcohol
const WEEKLY_COUNT_GOALS = [4, 7, 8, 10, 11];

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Public status/debug endpoint — no auth required
app.get('/api/status', async (req, res) => {
  try {
    const { rows: logCount  } = await query('SELECT COUNT(*) AS n FROM daily_logs');
    const { rows: goalCount } = await query('SELECT COUNT(*) AS n FROM goals');
    const hasDbUrl = !!process.env.DATABASE_URL;
    console.log(`[api/status] db ok — goals=${goalCount[0].n} logs=${logCount[0].n}`);
    res.json({ db: 'ok', goals: goalCount[0].n, logs: logCount[0].n, hasDbUrl });
  } catch (e) {
    console.error('[api/status] DB ERROR:', e.message);
    res.json({ db: 'error', error: e.message, hasDbUrl: !!process.env.DATABASE_URL });
  }
});

// GET all goals
app.get('/api/goals', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM goals ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET full trends data (monthly, quarterly, weekly) for a goal
app.get('/api/logs/trends/:goalId', async (req, res) => {
  try {
    const goalId = parseInt(req.params.goalId);
    const year   = new Date().getFullYear();
    const today  = new Date().toISOString().slice(0, 10);

    const { rows } = await query(
      'SELECT date, value FROM daily_logs WHERE goal_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC',
      [goalId, `${year}-01-01`, today]
    );

    // For Surf (goal 3), use Surf Sessions (goal 13) entries for session counts
    let sessionRows = null;
    if (goalId === 3) {
      const sr = await query(
        'SELECT date, value FROM daily_logs WHERE goal_id = 13 AND date >= $1 AND date <= $2 ORDER BY date ASC',
        [`${year}-01-01`, today]
      );
      sessionRows = sr.rows;
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
      weeks.push({ label: `W${wNum}`, total: +data.total.toFixed(3),
        avg: data.count > 0 ? +(data.total/data.count).toFixed(3) : 0,
        count: data.count, sessions: data.sessions,
        cumulative: +cumulative.toFixed(3), cumSessions });
      cur = addWeeks(cur, 1);
      wNum++;
    }

    res.json({ monthly, quarterly, weekly: weeks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET monthly breakdown for a single goal (for combo chart)
app.get('/api/logs/yearly/:goalId', async (req, res) => {
  try {
    const goalId = parseInt(req.params.goalId);
    const year   = new Date().getFullYear();
    const currentMonth = new Date().getMonth();

    const { rows } = await query(
      'SELECT date, value FROM daily_logs WHERE goal_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC',
      [goalId, `${year}-01-01`, `${year}-12-31`]
    );

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
app.get('/api/logs', async (req, res) => {
  try {
    const { rows: goals } = await query('SELECT * FROM goals ORDER BY id');
    const now       = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const today     = now.toISOString().slice(0, 10);
    const result    = [];

    for (const g of goals) {
      if (g.id === 12) continue;

      const { rows } = await query(
        'SELECT date, value FROM daily_logs WHERE goal_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC',
        [g.id, yearStart, today]
      );
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
app.get('/api/logs/monthly', async (req, res) => {
  try {
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: 'month param required' });
    const { rows } = await query(
      "SELECT goal_id, date, value FROM daily_logs WHERE date LIKE $1 ORDER BY date ASC",
      [`${month}%`]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST save daily logs (upserts entries, deletes cleared cells)
app.post('/api/log/daily', async (req, res) => {
  const { entries = [], deletions = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      if (e.value !== null && e.value !== undefined && e.value !== '') {
        await client.query(
          `INSERT INTO daily_logs (goal_id, date, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (goal_id, date) DO UPDATE SET value = EXCLUDED.value, logged_at = NOW()`,
          [e.goal_id, e.date, parseFloat(e.value)]
        );
      }
    }
    for (const d of deletions) {
      await client.query(
        'DELETE FROM daily_logs WHERE goal_id = $1 AND date = $2',
        [d.goal_id, d.date]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
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

// GET year-view data for 2026 (exercise, work, screen time, surf, reading per day)
app.get('/api/year-view/2026', async (req, res) => {
  try {
    const { rows } = await query(`
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
    `);

    const { rows: noteRows } = await query(`SELECT date FROM daily_notes WHERE note != ''`);
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

// GET current streaks for key habit goals
app.get('/api/streaks', async (req, res) => {
  try {
    const habitGoals = [
      { id: 6,  label: 'Exercise',     unit: 'days', fn: v => v >= 1 },
      { id: 3,  label: 'Surf',         unit: 'days', fn: v => v > 0 },
      { id: 10, label: 'Stretching',   unit: 'days', fn: v => v > 0 },
      { id: 11, label: 'Alcohol-free', unit: 'days', fn: v => v === 0, missingIsPass: true },
      { id: 2,  label: 'Screen time',  unit: 'days', fn: v => v <= 1.5 },
    ];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const results = [];
    for (const goal of habitGoals) {
      const { rows } = await query(
        `SELECT date::text, value FROM daily_logs WHERE goal_id = $1 AND date >= '2026-01-01' ORDER BY date DESC`,
        [goal.id]
      );
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

// GET all notes with text
app.get('/api/notes', async (req, res) => {
  try {
    const { rows } = await query(`SELECT date, note FROM daily_notes WHERE note != '' ORDER BY date ASC`);
    res.json({ notes: rows.map(r => ({ date: r.date, note: r.note })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET all dates that have a non-empty note
app.get('/api/notes/exists', async (req, res) => {
  try {
    const { rows } = await query(`SELECT date FROM daily_notes WHERE note != '' ORDER BY date`);
    res.json({ dates: rows.map(r => r.date) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET note + emojis for a specific date
app.get('/api/notes/:date', async (req, res) => {
  try {
    const { rows } = await query('SELECT note, emojis FROM daily_notes WHERE date = $1', [req.params.date]);
    res.json({ note: rows[0] ? rows[0].note : '', emojis: rows[0] ? (rows[0].emojis || '') : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST save/update a note + emojis
app.post('/api/notes', async (req, res) => {
  try {
    const { date, note, emojis } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    await query(
      `INSERT INTO daily_notes (date, note, emojis) VALUES ($1, $2, $3)
       ON CONFLICT (date) DO UPDATE SET note = EXCLUDED.note, emojis = EXCLUDED.emojis`,
      [date, note || '', emojis || '']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET all dates with manual emojis
app.get('/api/emojis', async (req, res) => {
  try {
    const { rows } = await query(`SELECT date, emojis FROM daily_notes WHERE emojis != '' ORDER BY date`);
    const map = {};
    rows.forEach(r => { map[r.date] = r.emojis.split(',').filter(Boolean); });
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATABASE INIT ────────────────────────────────────────────────────────────
async function initDb() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      priority TEXT,
      category TEXT,
      description TEXT,
      metric TEXT,
      kpi NUMERIC,
      unit TEXT,
      lower_is_better INTEGER DEFAULT 0
    )`);
    await query(`CREATE TABLE IF NOT EXISTS daily_logs (
      id SERIAL PRIMARY KEY,
      goal_id INTEGER REFERENCES goals(id),
      date TEXT NOT NULL,
      value NUMERIC NOT NULL,
      logged_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(goal_id, date)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS daily_notes (
      date TEXT PRIMARY KEY,
      note TEXT DEFAULT '',
      emojis TEXT DEFAULT ''
    )`);
    console.log('[init] core tables ready');
  } catch (e) { console.error('[init] initDb error:', e.message); }
}

// ─── STARTUP SEED ─────────────────────────────────────────────────────────────
// If production DB is empty, seed it from db-export.json (generated from dev DB)
async function seedIfEmpty() {
  try {
    const { rows } = await query('SELECT COUNT(*) AS n FROM goals');
    if (parseInt(rows[0].n) > 0) { console.log('[seed] DB already has data, skipping seed'); return; }
    console.log('[seed] DB is empty — seeding from db-export.json ...');
    const seed = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'db-export.json'), 'utf8'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const g of seed.goals) {
        await client.query(
          `INSERT INTO goals (id, name, priority, category, description, metric, kpi, unit, lower_is_better)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [g.id, g.name, g.priority, g.category, g.description, g.metric, g.kpi, g.unit, g.lower_is_better || 0]
        );
      }
      for (const l of seed.logs) {
        await client.query(
          `INSERT INTO daily_logs (goal_id, date, value) VALUES ($1,$2,$3) ON CONFLICT (goal_id, date) DO NOTHING`,
          [l.goal_id, l.date, l.value]
        );
      }
      for (const n of seed.notes) {
        await client.query(
          `INSERT INTO daily_notes (date, note) VALUES ($1,$2) ON CONFLICT (date) DO UPDATE SET note = EXCLUDED.note`,
          [n.date, n.note]
        );
      }
      await client.query('COMMIT');
      console.log(`[seed] Done — seeded ${seed.goals.length} goals, ${seed.logs.length} logs, ${seed.notes.length} notes`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[seed] FAILED:', e.message);
    } finally { client.release(); }
  } catch (e) { console.error('[seed] check failed:', e.message); }
}

// Always correct lower_is_better flags — fixes any seeded rows missing this value
async function fixGoalFlags() {
  try {
    const seed = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'db-export.json'), 'utf8'));
    for (const g of seed.goals) {
      await query('UPDATE goals SET lower_is_better = $1 WHERE id = $2', [g.lower_is_better || 0, g.id]);
    }
    console.log('[fix] goal flags updated');
  } catch (e) { console.error('[fix] goal flags error:', e.message); }
}

// Create calendar_events table if it doesn't exist
async function createEventsTable() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS calendar_events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6ea8ff',
      notes TEXT DEFAULT ''
    )`);
    await query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`);
    await query(`ALTER TABLE daily_notes ADD COLUMN IF NOT EXISTS emojis TEXT DEFAULT ''`);
    console.log('[init] calendar_events table ready');
  } catch (e) { console.error('[init] calendar_events error:', e.message); }
}

// GET all events
app.get('/api/events', async (req, res) => {
  try {
    const { rows } = await query(`SELECT id, name, start_date, end_date, color, notes FROM calendar_events ORDER BY start_date ASC`);
    res.json({ events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create event
app.post('/api/events', async (req, res) => {
  try {
    const { name, start_date, end_date, color, notes = '' } = req.body;
    if (!name || !start_date || !end_date || !color) return res.status(400).json({ error: 'Missing fields' });
    const { rows } = await query(
      `INSERT INTO calendar_events (name, start_date, end_date, color, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, start_date, end_date, color, notes]
    );
    res.json({ event: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT update event
app.put('/api/events/:id', async (req, res) => {
  try {
    const { name, start_date, end_date, color, notes = '' } = req.body;
    if (!name || !start_date || !end_date || !color) return res.status(400).json({ error: 'Missing fields' });
    const { rows } = await query(
      `UPDATE calendar_events SET name=$1, start_date=$2, end_date=$3, color=$4, notes=$5 WHERE id=$6 RETURNING *`,
      [name, start_date, end_date, color, notes, req.params.id]
    );
    res.json({ event: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE event
app.delete('/api/events/:id', async (req, res) => {
  try {
    await query(`DELETE FROM calendar_events WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create surf_sessions table (multi-session support)
async function createSurfSessionsTable() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS surf_sessions (
      date TEXT PRIMARY KEY,
      quality INTEGER,
      wave_size NUMERIC,
      swell_direction TEXT DEFAULT '',
      swell_stats TEXT DEFAULT '',
      location TEXT DEFAULT '',
      notes TEXT DEFAULT ''
    )`);
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS surfboard TEXT DEFAULT ''`);
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS swell_secondary TEXT DEFAULT ''`);
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS wave_size_min NUMERIC`);
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS wave_size_max NUMERIC`);
    await query(`ALTER TABLE surf_sessions ALTER COLUMN quality TYPE NUMERIC USING quality::NUMERIC`).catch(() => {});
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS wave_size TEXT DEFAULT ''`);
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS tide TEXT DEFAULT ''`);
    try { await query(`ALTER TABLE surf_sessions ALTER COLUMN wave_size TYPE TEXT USING wave_size::TEXT`); } catch(_) {}
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS wind TEXT DEFAULT ''`);
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS texture TEXT DEFAULT ''`);
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS time_start TEXT DEFAULT ''`);
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS time_end TEXT DEFAULT ''`);
    // Migrate: shift primary key from date → id to support multiple sessions per day
    await query(`ALTER TABLE surf_sessions ADD COLUMN IF NOT EXISTS id SERIAL`);
    try { await query(`ALTER TABLE surf_sessions DROP CONSTRAINT surf_sessions_pkey`); } catch(_) {}
    try { await query(`ALTER TABLE surf_sessions ADD PRIMARY KEY (id)`); } catch(_) {}
    console.log('[init] surf_sessions table ready');
  } catch (e) { console.error('[init] surf_sessions error:', e.message); }
}

// GET all surf sessions (journal)
app.get('/api/surf-sessions', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM surf_sessions ORDER BY date DESC, id DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET all sessions for a date
app.get('/api/surf-sessions/:date', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM surf_sessions WHERE date = $1 ORDER BY id ASC`,
      [req.params.date]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST — create new session
app.post('/api/surf-session', async (req, res) => {
  try {
    const { date, quality, wave_size = '', tide = '', swell_direction = '', swell_secondary = '', location = '', notes = '', surfboard = '', wind = '', time_start = '', time_end = '' } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    if (quality != null && (quality < 1 || quality > 4)) return res.status(400).json({ error: 'quality must be 1–4' });
    const { rows } = await query(
      `INSERT INTO surf_sessions (date, quality, wave_size, tide, swell_direction, swell_secondary, location, notes, surfboard, wind, time_start, time_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [date, quality || null, wave_size, tide, swell_direction, swell_secondary, location, notes, surfboard, wind, time_start, time_end]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT — update session by id
app.put('/api/surf-session/:id', async (req, res) => {
  try {
    const { quality, wave_size = '', tide = '', swell_direction = '', swell_secondary = '', location = '', notes = '', surfboard = '', wind = '', time_start = '', time_end = '' } = req.body;
    if (quality != null && (quality < 1 || quality > 4)) return res.status(400).json({ error: 'quality must be 1–4' });
    await query(
      `UPDATE surf_sessions SET quality=$1, wave_size=$2, tide=$3, swell_direction=$4, swell_secondary=$5, location=$6, notes=$7, surfboard=$8, wind=$9, time_start=$10, time_end=$11
       WHERE id=$12`,
      [quality || null, wave_size, tide, swell_direction, swell_secondary, location, notes, surfboard, wind, time_start, time_end, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE — remove session by id
app.delete('/api/surf-session/:id', async (req, res) => {
  try {
    await query(`DELETE FROM surf_sessions WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

initDb()
  .then(seedIfEmpty)
  .then(fixGoalFlags)
  .then(createEventsTable)
  .then(createSurfSessionsTable)
  .then(() => {
    app.listen(PORT, () => console.log(`Goals tracker running on http://localhost:${PORT}`));
  });
