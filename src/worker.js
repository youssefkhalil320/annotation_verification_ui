const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const ANNOTATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const MAX_DOC_ID_LENGTH = 256;
const MAX_REVIEW_BYTES = 1_500_000;
const MAX_BATCH_SIZE = 100;
let schemaReady;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function validAnnotatorId(value) {
  return typeof value === 'string' && ANNOTATOR_RE.test(value);
}

function validDocId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DOC_ID_LENGTH;
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_REVIEW_BYTES) throw new Error('Request body is too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_REVIEW_BYTES) throw new Error('Request body is too large');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

async function registerAnnotator(db, annotatorId, now) {
  await db.prepare(`
    INSERT INTO annotators (annotator_id, created_at, last_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT (annotator_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).bind(annotatorId, now, now).run();
}

async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS annotators (
        annotator_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_states (
        annotator_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        text_len INTEGER NOT NULL,
        payload TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (annotator_id, doc_id),
        FOREIGN KEY (annotator_id) REFERENCES annotators(annotator_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS review_states_updated_at
        ON review_states (annotator_id, updated_at DESC);
    `).catch(error => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

async function handleApi(request, env) {
  if (!env.REVIEW_DB) return error('The REVIEW_DB binding is not configured', 503);
  await ensureSchema(env.REVIEW_DB);

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const now = new Date().toISOString();

  if (url.pathname === '/api/health' && method === 'GET') {
    return json({ ok: true, storage: 'd1' });
  }

  if (url.pathname === '/api/annotators/register' && method === 'POST') {
    const body = await readJson(request);
    if (!validAnnotatorId(body.annotator_id)) {
      return error('Annotator ID must be 2-64 characters using letters, numbers, dots, underscores, or hyphens');
    }
    await registerAnnotator(env.REVIEW_DB, body.annotator_id, now);
    return json({ annotator_id: body.annotator_id });
  }

  if (url.pathname === '/api/reviews/batch' && method === 'POST') {
    const body = await readJson(request);
    if (!validAnnotatorId(body.annotator_id)) return error('Invalid annotator ID');
    if (!Array.isArray(body.doc_ids) || body.doc_ids.length > MAX_BATCH_SIZE || body.doc_ids.some(id => !validDocId(id))) {
      return error(`doc_ids must contain at most ${MAX_BATCH_SIZE} valid document IDs`);
    }
    if (!body.doc_ids.length) return json({ reviews: [] });
    await registerAnnotator(env.REVIEW_DB, body.annotator_id, now);
    const placeholders = body.doc_ids.map(() => '?').join(',');
    const result = await env.REVIEW_DB.prepare(`
      SELECT doc_id, payload, updated_at, revision
      FROM review_states
      WHERE annotator_id = ? AND doc_id IN (${placeholders})
    `).bind(body.annotator_id, ...body.doc_ids).all();
    const reviews = (result.results || []).map(row => {
      try {
        return { doc_id: row.doc_id, ...JSON.parse(row.payload), updated_at: row.updated_at, revision: row.revision };
      } catch {
        return null;
      }
    }).filter(Boolean);
    return json({ reviews });
  }

  if (url.pathname.startsWith('/api/reviews/') && method === 'PUT') {
    let docId;
    try {
      docId = decodeURIComponent(url.pathname.slice('/api/reviews/'.length));
    } catch {
      return error('Invalid document ID');
    }
    if (!validDocId(docId)) return error('Invalid document ID');
    const body = await readJson(request);
    if (!validAnnotatorId(body.annotator_id)) return error('Invalid annotator ID');
    if (!Number.isInteger(body.text_len) || body.text_len < 0 || !Array.isArray(body.entities) || typeof body.complete !== 'boolean') {
      return error('Invalid review payload');
    }
    const payload = JSON.stringify({
      text_len: body.text_len,
      entities: body.entities,
      complete: body.complete,
      updated_at: body.updated_at || now,
    });
    if (new TextEncoder().encode(payload).length > MAX_REVIEW_BYTES) return error('Review payload is too large', 413);
    await registerAnnotator(env.REVIEW_DB, body.annotator_id, now);
    const saved = await env.REVIEW_DB.prepare(`
      INSERT INTO review_states (annotator_id, doc_id, text_len, payload, complete, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (annotator_id, doc_id) DO UPDATE SET
        text_len = excluded.text_len,
        payload = excluded.payload,
        complete = excluded.complete,
        updated_at = excluded.updated_at,
        revision = review_states.revision + 1
      RETURNING revision, updated_at
    `).bind(body.annotator_id, docId, body.text_len, payload, body.complete ? 1 : 0, now).first();
    return json({ ok: true, doc_id: docId, revision: saved?.revision, updated_at: saved?.updated_at || now });
  }

  if (url.pathname === '/api/reviews/clear' && method === 'POST') {
    const body = await readJson(request);
    if (!validAnnotatorId(body.annotator_id)) return error('Invalid annotator ID');
    if (!Array.isArray(body.doc_ids) || body.doc_ids.length > MAX_BATCH_SIZE || body.doc_ids.some(id => !validDocId(id))) {
      return error(`doc_ids must contain at most ${MAX_BATCH_SIZE} valid document IDs`);
    }
    if (body.doc_ids.length) {
      const placeholders = body.doc_ids.map(() => '?').join(',');
      await env.REVIEW_DB.prepare(`
        DELETE FROM review_states WHERE annotator_id = ? AND doc_id IN (${placeholders})
      `).bind(body.annotator_id, ...body.doc_ids).run();
    }
    return json({ ok: true, deleted: body.doc_ids.length });
  }

  return error('API route not found', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'GET, POST, PUT, OPTIONS' } });
    try {
      return await handleApi(request, env);
    } catch (err) {
      console.error('Review API error', err);
      return error(err instanceof Error ? err.message : 'Internal server error', 500);
    }
  },
};

export { handleApi, validAnnotatorId };
