'use strict';

const path = require('path');
const express = require('express');

const db = require('./lib/db');
const auth = require('./lib/auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const PORT = parseInt(process.env.PORT, 10) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

db.init();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));

app.use(auth.sessionMiddleware);

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).send('404 Not Found');
});

// error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('ERROR:', err);
  if (res.headersSent) return res.end();
  res.status(500).send('500 Internal Server Error');
});

app.listen(PORT, HOST, () => {
  console.log(`Blog running at http://${HOST}:${PORT}`);
});
