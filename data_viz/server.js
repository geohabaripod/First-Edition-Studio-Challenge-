require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const routes = require('./routes.js');

const app = express();

app.use(cors({
  origin: (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim()),
}));

// Pre-generated static-layer PNGs (study area, roads, rivers, buildings) —
// see generate-static-layers.js. Served as plain files, not through /api,
// since they're static assets rather than per-request computed data.
app.use('/static', express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  try {
    const { query } = require('./db');
    await query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use('/api', routes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Flood risk API listening on :${port}`));