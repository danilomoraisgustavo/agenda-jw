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

async function getNotebookById(notebookId) {
  const notebook = await get(
    `SELECT id, title, color, created_at AS createdAt, updated_at AS updatedAt
     FROM notebooks
     WHERE id = ?`,
    [notebookId]
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

async function listNotebooks() {
  const notebooks = await all(
    `SELECT id, title, color, created_at AS createdAt, updated_at AS updatedAt
     FROM notebooks
     ORDER BY datetime(created_at) ASC, rowid ASC`
  );

  const pages = await all(
    `SELECT notebook_id AS notebookId, page_number AS pageNumber, title, content, created_at AS createdAt, updated_at AS updatedAt
     FROM pages
     ORDER BY notebook_id ASC, page_number ASC`
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

async function createNotebook(notebookInput) {
  const notebookId = crypto.randomUUID();
  const now = new Date().toISOString();
  const notebook = normalizeNotebook(notebookInput);

  await transaction(async () => {
    await run(
      `INSERT INTO notebooks (id, title, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [notebookId, notebook.title, notebook.color, now, now]
    );

    for (const page of notebook.pages) {
      await run(
        `INSERT INTO pages (notebook_id, page_number, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [notebookId, page.pageNumber, page.title, page.content, now, now]
      );
    }
  });

  return getNotebookById(notebookId);
}

async function replaceNotebook(notebookId, notebookInput) {
  const existing = await get('SELECT id FROM notebooks WHERE id = ?', [notebookId]);
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

  return getNotebookById(notebookId);
}

async function deleteNotebook(notebookId) {
  const existing = await get('SELECT id FROM notebooks WHERE id = ?', [notebookId]);
  if (!existing) {
    return false;
  }

  await transaction(async () => {
    await run('DELETE FROM pages WHERE notebook_id = ?', [notebookId]);
    await run('DELETE FROM notebooks WHERE id = ?', [notebookId]);
  });

  return true;
}

async function seedInitialData() {
  const row = await get('SELECT COUNT(*) AS total FROM notebooks');
  if (row.total > 0) {
    return;
  }

  const samples = [
    { title: 'Textos Bíblicos', color: 'nb-brown' },
    { title: 'Personagens Bíblicos', color: 'nb-green' },
    { title: 'JW Broadcasting', color: 'nb-blue' }
  ];

  for (const sample of samples) {
    await createNotebook(sample);
  }
}

async function initDatabase() {
  await run('PRAGMA foreign_keys = ON');

  await run(
    `CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
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

  await seedInitialData();
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/notebooks', async (_req, res, next) => {
  try {
    const notebooks = await listNotebooks();
    res.json({ notebooks });
  } catch (error) {
    next(error);
  }
});

app.post('/api/notebooks', async (req, res, next) => {
  try {
    const notebook = await createNotebook(req.body || {});
    res.status(201).json({ notebook });
  } catch (error) {
    next(error);
  }
});

app.put('/api/notebooks/:id', async (req, res, next) => {
  try {
    const notebook = await replaceNotebook(req.params.id, req.body || {});
    if (!notebook) {
      res.status(404).json({ error: 'Caderno não encontrado.' });
      return;
    }
    res.json({ notebook });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/notebooks/:id', async (req, res, next) => {
  try {
    const deleted = await deleteNotebook(req.params.id);
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
