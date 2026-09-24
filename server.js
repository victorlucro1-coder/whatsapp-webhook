const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
// Queries and billable AI calls stay unavailable until authenticated access is deployed.
app.use('/api', (_req, res) => res.status(503).json({ error: 'Authenticated service not deployed' }));
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
function readMessages() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; } }
function writeMessages(items) { fs.writeFileSync(DATA_FILE, JSON.stringify(items.slice(-10000), null, 2)); }
function verifySignature(req) {
  if (!APP_SECRET) return false;
  const signature = req.get('x-hub-signature-256') || '';
  const raw = req.rawBody;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
function ingest(body) {
  const out = readMessages();
  for (const entry of (body.entry || [])) for (const change of (entry.changes || [])) {
    const value = change.value || {};
    for (const msg of (value.messages || [])) {
      const contact = (value.contacts || []).find(c => c.wa_id === msg.from) || {};
      if (!out.some(x => x.id === msg.id)) out.push({ id: msg.id, phone: msg.from, contact_name: contact.profile?.name || '', body: msg.text?.body || `[${msg.type}]`, direction: 'received', timestamp: Number(msg.timestamp || Math.floor(Date.now()/1000)), status: 'received', conversation_id: msg.from });
    }
    for (const status of (value.statuses || [])) { const found = out.find(x => x.id === status.id); if (found) found.status = status.status; }
  }
  writeMessages(out);
  return out.length;
}
app.get('/', (_req, res) => res.status(200).send('WhatsApp webhook online'));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: 'security-hold-1' }));
app.get('/webhook', (req, res) => { if (VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) return res.status(200).send(req.query['hub.challenge'] || ''); return res.sendStatus(403); });
app.post('/webhook', (req, res) => { if (!APP_SECRET || process.env.DURABLE_STORAGE_READY !== 'true') return res.sendStatus(503); if (!verifySignature(req)) return res.sendStatus(401); const count = ingest(req.body); console.log('WhatsApp event stored; total:', count); return res.sendStatus(200); });
app.get('/api/messages', (req, res) => { let items = readMessages(); if (req.query.phone) items = items.filter(x => x.phone === String(req.query.phone)); if (req.query.q) items = items.filter(x => x.body.toLowerCase().includes(String(req.query.q).toLowerCase())); res.json(items.slice(-Number(req.query.limit || 100))); });
app.get('/api/conversations', (_req, res) => { const map = new Map(); for (const m of readMessages()) map.set(m.conversation_id, { conversation_id: m.conversation_id, phone: m.phone, contact_name: m.contact_name, last_message: m.body, last_timestamp: m.timestamp }); res.json([...map.values()].sort((a,b) => b.last_timestamp-a.last_timestamp)); });
app.post('/api/summarize', async (req, res) => { if (!OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY não configurada' }); const messages = readMessages().filter(m => !req.body.phone || m.phone === req.body.phone).slice(-100); const input = messages.map(m => `${m.direction === 'received' ? 'Cliente' : 'Empresa'}: ${m.body}`).join('\\n'); const r = await fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'}, body:JSON.stringify({model:OPENAI_MODEL, temperature:0.2, messages:[{role:'system',content:'Resuma a conversa em português, destaque pendências e próxima ação. Use somente as mensagens fornecidas.'},{role:'user',content:input}]}) }); if (!r.ok) return res.status(502).json({ error: 'Falha na API OpenAI' }); const data = await r.json(); res.json({ summary: data.choices?.[0]?.message?.content || '' }); });
const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => console.log(`Webhook listening on port ${port}`));
