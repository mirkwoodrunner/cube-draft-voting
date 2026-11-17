'use strict';

const path = require('path');
const express = require('express');
const { pool, migrate } = require('./src/db');
const { router } = require('./src/routes');
const discord = require('./src/discord');
const { rateLimit } = require('./src/ratelimit');

const app = express();
app.disable('x-powered-by');
// Render sits in front of the app, so req.ip comes from X-Forwarded-For. TRUST_PROXY is the number of proxies.
const hops = Number(process.env.TRUST_PROXY);
app.set('trust proxy', Number.isInteger(hops) && hops >= 0 && process.env.TRUST_PROXY !== '' ? hops : 1);

// Limits are per IP and generous, since players at one store often share an IP.
const MIN = 60 * 1000;
const onPost = (limiter) => (req, res, next) => (req.method === 'POST' ? limiter(req, res, next) : next());
const onPut = (limiter) => (req, res, next) => (req.method === 'PUT' ? limiter(req, res, next) : next());
app.use('/api/owner/login', rateLimit({ windowMs: 15 * MIN, limit: 10, onlyFailures: true, message: 'Too many wrong passwords. Wait 15 minutes and try again.' }));
const creating = rateLimit({ windowMs: 10 * MIN, limit: 30 });
app.post('/api/sessions', creating);
app.use('/api/cubecobra/preview', onPost(creating));
app.use('/api/sessions/:sessionId/vote', onPost(rateLimit({ windowMs: MIN, limit: 60 })));
const uploads = rateLimit({ windowMs: 10 * MIN, limit: 60 });
app.use('/api/drafts/:id/decks/mine/photo', onPut(uploads));
app.use('/api/admin/:adminToken/decks/photo', onPut(uploads));

app.use(express.json({ limit: '100kb' }));
app.use('/api', router);

const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { index: false }));
const page = (file) => (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(pub, file));
};
app.get('/', page('index.html'));
app.get('/vote/:sessionId', page('vote.html'));
app.get('/admin/:adminToken', page('admin.html'));
app.get('/owner', page('owner.html'));
app.get('/players', page('players.html'));
app.get('/players/:id', page('player.html'));
app.get('/players/name/:name', page('player.html'));
app.get('/library', page('library.html'));

// Discord login. Off unless DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are set.
const authOff = (req, res) => res.status(404).type('text').send('Discord login is turned off on this server');
app.get('/auth/discord', (req, res) => (discord.enabled() ? discord.start(req, res) : authOff(req, res)));
app.get('/auth/discord/callback', (req, res, next) => (discord.enabled() ? discord.callback(req, res).catch(next) : authOff(req, res)));
app.use((req, res) => res.status(404).type('text').send('Not found'));

const PORT = process.env.PORT || 3000;

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  await migrate();
  console.log('Database ready');
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch((err) => {
  console.error('Startup failed:', err);
  pool.end().finally(() => process.exit(1));
});
