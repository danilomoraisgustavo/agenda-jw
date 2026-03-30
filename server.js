const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'study-notebooks.sqlite');
const NOTEBOOK_COLORS = ['nb-brown', 'nb-cream', 'nb-green', 'nb-blue', 'nb-rose', 'nb-dark'];
const SESSION_COOKIE = 'agenda_jw_session';
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30;

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

async function transaction(work) {
  await run('BEGIN TRANSACTION');
  try {
    const result = await work();
    await run('COMMIT');
    return result;
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}

function randomColorClass() {
  return NOTEBOOK_COLORS[Math.floor(Math.random() * NOTEBOOK_COLORS.length)];
}

function parseCookies(headerValue = '') {
  return headerValue
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) {
        return acc;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_DURATION_MS / 1000)
  }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(0),
    maxAge: 0
  }));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash = '') {
  const [salt, originalKey] = String(storedHash).split(':');
  if (!salt || !originalKey) {
    return false;
  }

  const derivedBuffer = crypto.scryptSync(password, salt, 64);
  const originalBuffer = Buffer.from(originalKey, 'hex');

  if (derivedBuffer.length !== originalBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(derivedBuffer, originalBuffer);
}

function normalizeEmail(value = '') {
  return String(value).trim().toLowerCase();
}

function normalizeAuthInput(input = {}) {
  return {
    name: String(input.name || '').trim(),
    email: normalizeEmail(input.email),
    password: String(input.password || '')
  };
}

function assertValidAuthInput(input, { requireName = false } = {}) {
  if (requireName && input.name.length < 2) {
    throw new Error('Informe um nome com pelo menos 2 caracteres.');
  }

  if (!input.email || !input.email.includes('@')) {
    throw new Error('Informe um e-mail válido.');
  }

  if (input.password.length < 6) {
    throw new Error('A senha deve ter pelo menos 6 caracteres.');
  }
}

function normalizeNotebook(input = {}) {
  const title = String(input.title || '').trim() || 'Novo Caderno';
  const color = NOTEBOOK_COLORS.includes(input.color) ? input.color : randomColorClass();
  const pages = Array.isArray(input.pages) && input.pages.length
    ? input.pages.map((page, index) => ({
        title: String(page?.title || '').trim(),
        content: String(page?.content || ''),
        pageNumber: Number.isInteger(page?.pageNumber) ? page.pageNumber : index + 1
      }))
    : [
        { title: 'Página 1', content: '', pageNumber: 1 },
        { title: 'Página 2', content: '', pageNumber: 2 }
      ];

  return { title, color, pages };
}

async function getNotebookById(notebookId, ownerId) {
  const notebook = await get(
    `SELECT id, owner_id AS ownerId, title, color, created_at AS createdAt, updated_at AS updatedAt
     FROM notebooks
     WHERE id = ? AND owner_id = ?`,
    [notebookId, ownerId]
  );

  if (!notebook) {
    return null;
  }

  const pages = await all(
    `SELECT page_number AS pageNumber, title, content, created_at AS createdAt, updated_at AS updatedAt
     FROM pages
     WHERE notebook_id = ?
     ORDER BY page_number ASC`,
    [notebookId]
  );

  return { ...notebook, pages };
}

async function listNotebooks(ownerId) {
  const notebooks = await all(
    `SELECT id, owner_id AS ownerId, title, color, created_at AS createdAt, updated_at AS updatedAt
     FROM notebooks
     WHERE owner_id = ?
     ORDER BY datetime(created_at) ASC, rowid ASC`
    ,
    [ownerId]
  );

  const pages = await all(
    `SELECT notebook_id AS notebookId, page_number AS pageNumber, title, content, created_at AS createdAt, updated_at AS updatedAt
     FROM pages
     WHERE notebook_id IN (
       SELECT id FROM notebooks WHERE owner_id = ?
     )
     ORDER BY notebook_id ASC, page_number ASC`
    ,
    [ownerId]
  );

  const pagesByNotebook = new Map();
  for (const page of pages) {
    if (!pagesByNotebook.has(page.notebookId)) {
      pagesByNotebook.set(page.notebookId, []);
    }
    pagesByNotebook.get(page.notebookId).push({
      pageNumber: page.pageNumber,
      title: page.title,
      content: page.content,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt
    });
  }

  return notebooks.map((notebook) => ({
    ...notebook,
    pages: pagesByNotebook.get(notebook.id) || []
  }));
}

async function createNotebook(ownerId, notebookInput) {
  const notebookId = crypto.randomUUID();
  const now = new Date().toISOString();
  const notebook = normalizeNotebook(notebookInput);

  await transaction(async () => {
    await run(
      `INSERT INTO notebooks (id, owner_id, title, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [notebookId, ownerId, notebook.title, notebook.color, now, now]
    );

    for (const page of notebook.pages) {
      await run(
        `INSERT INTO pages (notebook_id, page_number, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [notebookId, page.pageNumber, page.title, page.content, now, now]
      );
    }
  });

  return getNotebookById(notebookId, ownerId);
}

async function replaceNotebook(ownerId, notebookId, notebookInput) {
  const existing = await get('SELECT id FROM notebooks WHERE id = ? AND owner_id = ?', [notebookId, ownerId]);
  if (!existing) {
    return null;
  }

  const notebook = normalizeNotebook(notebookInput);
  const now = new Date().toISOString();

  await transaction(async () => {
    await run(
      `UPDATE notebooks
       SET title = ?, color = ?, updated_at = ?
       WHERE id = ?`,
      [notebook.title, notebook.color, now, notebookId]
    );

    await run('DELETE FROM pages WHERE notebook_id = ?', [notebookId]);

    for (const page of notebook.pages) {
      await run(
        `INSERT INTO pages (notebook_id, page_number, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [notebookId, page.pageNumber, page.title, page.content, now, now]
      );
    }
  });

  return getNotebookById(notebookId, ownerId);
}

async function deleteNotebook(ownerId, notebookId) {
  const existing = await get('SELECT id FROM notebooks WHERE id = ? AND owner_id = ?', [notebookId, ownerId]);
  if (!existing) {
    return false;
  }

  await transaction(async () => {
    await run('DELETE FROM pages WHERE notebook_id = ?', [notebookId]);
    await run('DELETE FROM notebooks WHERE id = ?', [notebookId]);
  });

  return true;
}

async function findUserByEmail(email) {
  return get(
    `SELECT id, name, email, password_hash AS passwordHash, created_at AS createdAt, updated_at AS updatedAt
     FROM users
     WHERE email = ?`,
    [email]
  );
}

async function getSafeUserById(userId) {
  return get(
    `SELECT id, name, email, created_at AS createdAt, updated_at AS updatedAt
     FROM users
     WHERE id = ?`,
    [userId]
  );
}

async function createUser({ name, email, password }) {
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = hashPassword(password);

  await run(
    `INSERT INTO users (id, name, email, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, name, email, passwordHash, now, now]
  );

  return getSafeUserById(userId);
}

async function createSession(userId) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS).toISOString();

  await run(
    `INSERT INTO sessions (token, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
    [sessionToken, userId, now.toISOString(), expiresAt]
  );

  return sessionToken;
}

async function getUserFromSessionToken(token) {
  if (!token) {
    return null;
  }

  const session = await get(
    `SELECT s.token, s.user_id AS userId, s.expires_at AS expiresAt,
            u.id, u.name, u.email, u.created_at AS createdAt, u.updated_at AS updatedAt
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`,
    [token]
  );

  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }

  return {
    id: session.id,
    name: session.name,
    email: session.email,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

async function deleteSession(token) {
  if (!token) {
    return;
  }

  await run('DELETE FROM sessions WHERE token = ?', [token]);
}

async function addColumnIfMissing(tableName, columnName, definition) {
  const columns = await all(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function cleanupExpiredSessions() {
  await run(`DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')`);
}

async function attachUser(req, _res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE];
    req.sessionToken = token || null;
    req.user = await getUserFromSessionToken(token);
    next();
  } catch (error) {
    next(error);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Faça login para continuar.' });
    return;
  }

  next();
}

async function initDatabase() {
  await run('PRAGMA foreign_keys = ON');

  await run(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      title TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notebook_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(notebook_id, page_number),
      FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
    )`
  );

  await addColumnIfMissing('notebooks', 'owner_id', 'TEXT');
  await cleanupExpiredSessions();
}

app.use(express.json({ limit: '12mb' }));
app.use(attachUser);
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user || null });
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const input = normalizeAuthInput(req.body || {});
    assertValidAuthInput(input, { requireName: true });

    const existingUser = await findUserByEmail(input.email);
    if (existingUser) {
      res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
      return;
    }

    const user = await createUser(input);
    const sessionToken = await createSession(user.id);
    setSessionCookie(res, sessionToken);
    res.status(201).json({ user });
  } catch (error) {
    if (error.message?.startsWith('Informe ') || error.message?.startsWith('A senha')) {
      res.status(400).json({ error: error.message });
      return;
    }

    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const input = normalizeAuthInput(req.body || {});
    assertValidAuthInput({ ...input, password: input.password }, { requireName: false });

    const user = await findUserByEmail(input.email);
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      res.status(401).json({ error: 'E-mail ou senha inválidos.' });
      return;
    }

    const sessionToken = await createSession(user.id);
    setSessionCookie(res, sessionToken);
    const safeUser = await getSafeUserById(user.id);
    res.json({ user: safeUser });
  } catch (error) {
    if (error.message?.startsWith('Informe ') || error.message?.startsWith('A senha')) {
      res.status(400).json({ error: error.message });
      return;
    }

    next(error);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    await deleteSession(req.sessionToken);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/notebooks', requireAuth, async (req, res, next) => {
  try {
    const notebooks = await listNotebooks(req.user.id);
    res.json({ notebooks });
  } catch (error) {
    next(error);
  }
});

app.post('/api/notebooks', requireAuth, async (req, res, next) => {
  try {
    const notebook = await createNotebook(req.user.id, req.body || {});
    res.status(201).json({ notebook });
  } catch (error) {
    next(error);
  }
});

app.put('/api/notebooks/:id', requireAuth, async (req, res, next) => {
  try {
    const notebook = await replaceNotebook(req.user.id, req.params.id, req.body || {});
    if (!notebook) {
      res.status(404).json({ error: 'Caderno não encontrado.' });
      return;
    }
    res.json({ notebook });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/notebooks/:id', requireAuth, async (req, res, next) => {
  try {
    const deleted = await deleteNotebook(req.user.id, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Caderno não encontrado.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor rodando em http://localhost:${PORT}`);
      console.log(`Banco SQLite em ${DB_PATH}`);
    });
  })
  .catch((error) => {
    console.error('Falha ao iniciar o servidor:', error);
    process.exit(1);
  });
