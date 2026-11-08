const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnv();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'chats.json');
const COOKIE_NAME = 'meta_demo_session';
const SESSION_SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-secret-change-me');
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGE_CHARS = 12000;
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
let store = { chats: {} };
let saveQueue = Promise.resolve();

if (process.env.NODE_ENV === 'production' && !SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

async function initialize() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8'));
    if (parsed && parsed.chats && typeof parsed.chats === 'object') store = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function persist() {
  const snapshot = JSON.stringify(store);
  saveQueue = saveQueue.then(async () => {
    const temp = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, snapshot, { mode: 0o600 });
    await fs.promises.rename(temp, DATA_FILE);
  });
  return saveQueue;
}

function signature(id) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(id).digest('hex');
}
function getSession(req, res) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(pair => pair.length === 2));
  const [id, supplied] = (cookies[COOKIE_NAME] || '').split('.');
  let valid = false;
  if (id && supplied) {
    const expected = Buffer.from(signature(id));
    const actual = Buffer.from(supplied);
    valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  if (!valid) {
    const newId = crypto.randomUUID();
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${newId}.${signature(newId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`);
    return newId;
  }
  return id;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function safeChat(chat) {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, messages: chat.messages };
}
function getOwnedChat(id, owner) {
  const chat = store.chats[id];
  return chat && chat.owner === owner ? chat : null;
}
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if (origin !== expected) {
    const error = new Error('Cross-origin request rejected.');
    error.status = 403;
    throw error;
  }
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Request must contain valid JSON.'); error.status = 400; throw error; }
}
function validateMessage(value) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('Message cannot be empty.'); error.status = 400; throw error;
  }
  if (value.length > MAX_MESSAGE_CHARS) {
    const error = new Error(`Message must be ${MAX_MESSAGE_CHARS} characters or fewer.`); error.status = 400; throw error;
  }
  return value.trim();
}
async function createCompletion(messages) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.AI_MODEL;
  if (!apiKey || !model) {
    const error = new Error('AI is not configured yet. Add AI_API_KEY and AI_MODEL to your .env file, then restart the server.');
    error.status = 503;
    throw error;
  }
  let url;
  try { url = new URL(`${baseUrl}/chat/completions`); }
  catch { const error = new Error('AI_BASE_URL is not a valid URL.'); error.status = 500; throw error; }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    const error = new Error('AI_BASE_URL must use HTTPS except for a local development server.'); error.status = 500; throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, temperature: 0.7 }) });
    if (!response.ok) {
      const error = new Error(`AI provider request failed (${response.status}). Check your provider settings and try again.`);
      error.status = 502;
      throw error;
    }
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      const error = new Error('The AI provider returned an empty response.'); error.status = 502; throw error;
    }
    return content.trim();
  } catch (error) {
    if (error.name === 'AbortError') { const timeoutError = new Error('The AI provider took too long to respond. Please try again.'); timeoutError.status = 504; throw timeoutError; }
    throw error;
  } finally { clearTimeout(timeout); }
}

async function handleApi(req, res, url, owner) {
  if (req.method === 'GET' && url.pathname === '/api/chats') {
    const chats = Object.values(store.chats).filter(chat => chat.owner === owner).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(chat => ({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt }));
    return sendJson(res, 200, { chats });
  }
  if (req.method === 'POST' && url.pathname === '/api/chats') {
    assertSameOrigin(req);
    const body = await readJson(req);
    const message = validateMessage(body.message);
    const now = new Date().toISOString();
    const chat = { id: crypto.randomUUID(), owner, title: message.slice(0, 60), createdAt: now, updatedAt: now, messages: [] };
    const reply = await createCompletion([{ role: 'user', content: message }]);
    chat.messages.push({ role: 'user', content: message, createdAt: now }, { role: 'assistant', content: reply, createdAt: new Date().toISOString() });
    chat.updatedAt = new Date().toISOString();
    store.chats[chat.id] = chat;
    await persist();
    return sendJson(res, 201, { chat: safeChat(chat) });
  }
  const match = url.pathname.match(/^\/api\/chats\/([0-9a-f-]{36})(?:\/(messages))?$/i);
  if (!match) return sendJson(res, 404, { error: 'Not found.' });
  const [, id, messagesRoute] = match;
  const chat = getOwnedChat(id, owner);
  if (req.method === 'GET' && !messagesRoute) {
    if (!chat) return sendJson(res, 404, { error: 'Chat not found.' });
    return sendJson(res, 200, { chat: safeChat(chat) });
  }
  if (req.method === 'DELETE' && !messagesRoute) {
    assertSameOrigin(req);
    if (!chat) return sendJson(res, 404, { error: 'Chat not found.' });
    delete store.chats[id];
    await persist();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && messagesRoute) {
    assertSameOrigin(req);
    if (!chat) return sendJson(res, 404, { error: 'Chat not found.' });
    const body = await readJson(req);
    const message = validateMessage(body.message);
    const context = [...chat.messages.slice(-30).map(({ role, content }) => ({ role, content })), { role: 'user', content: message }];
    const reply = await createCompletion(context);
    const now = new Date().toISOString();
    chat.messages.push({ role: 'user', content: message, createdAt: now }, { role: 'assistant', content: reply, createdAt: new Date().toISOString() });
    chat.updatedAt = new Date().toISOString();
    await persist();
    return sendJson(res, 200, { chat: safeChat(chat) });
  }
  return sendJson(res, 405, { error: 'Method not allowed.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const owner = getSession(req, res);
      return await handleApi(req, res, url, owner);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, requested);
    if (!file.startsWith(`${ROOT}${path.sep}`) || file === DATA_FILE || file.startsWith(`${DATA_DIR}${path.sep}`)) return sendJson(res, 404, { error: 'Not found.' });
    let contents;
    try { contents = await fs.promises.readFile(file); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') return sendJson(res, 404, { error: 'Not found.' }); throw error; }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': contents.length, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'An unexpected server error occurred.' });
    else res.destroy();
    if (!error.status) console.error(error);
  }
});

initialize().then(() => server.listen(PORT, HOST, () => console.log(`Meta AI app running at http://${HOST}:${PORT}`))).catch(error => { console.error('Could not initialize app data:', error); process.exit(1); });
