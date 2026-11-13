'use strict';

const path = require('path');
const express = require('express');
const { pool, migrate } = require('./src/db');
const { router } = require('./src/routes');
const discord = require('./src/discord');

const app = express();
app.disable('x-powered-by');
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
