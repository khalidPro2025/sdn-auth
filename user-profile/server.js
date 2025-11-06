const express = require('express');
const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/me', (req, res) => {
  res.json({
    user: req.headers['x-user'] || 'Anonymous',
    email: req.headers['x-email'] || 'unknown@example.com',
    note: 'Exposé via /profile/me (entêtes fournis par nginx + oauth2-proxy)'
  });
});

const PORT = 4100;
app.listen(PORT, '0.0.0.0', () => console.log(`User Profile listening on ${PORT}`));
