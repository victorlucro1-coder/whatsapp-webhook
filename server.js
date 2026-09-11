const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

app.get('/', (_req, res) => {
  res.status(200).send('WhatsApp webhook online');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  console.log('WhatsApp webhook event:', JSON.stringify(req.body));
  return res.sendStatus(200);
});

const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Webhook listening on port ${port}`);
});
