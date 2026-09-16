export const DATA_LIMIT = 300_000_000;
export const META_LIMIT = 5_000_000;
export const SUBMISSION_LIMIT = 2_000_000_000;
export const RECORDING_LIMIT = 10;
export const PART_SIZE = 16 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const TRIAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CONTACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const jwksCache = new Map();

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function optionalText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) throw httpError(400, `Text field exceeds ${max} characters`);
  return text;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function pathUrl(base, key) {
  return String(base || '').replace(/\/+$/, '') + '/' +
    key.split('/').map(encodeURIComponent).join('/');
}

function allowedOrigin(origin, env) {
  if (!origin) return null;
  const configured = String(env.PUBLIC_SITE_ORIGIN || 'https://gnuradioworld.com');
  if (origin === configured || origin === 'https://www.gnuradioworld.com' ||
      origin === 'https://gnuradio-wasm.pages.dev' ||
      origin === 'http://localhost:8090' || origin === 'http://127.0.0.1:8090' ||
      /^https:\/\/[a-z0-9-]+\.gnuradio-world-previews\.pages\.dev$/i.test(origin)) return origin;
  return null;
}

function corsHeaders(request, env, admin = false) {
  const origin = allowedOrigin(request.headers.get('Origin'), env);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    ...(admin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
  };
}

function withCors(response, request, env, admin = false) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env, admin))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function sigmfBytesPerSample(datatype) {
  const match = typeof datatype === 'string'
    ? /^([rc])[fiu](\d+)(?:_(?:le|be))?$/i.exec(datatype.trim()) : null;
  if (!match) return null;
  const bytes = (match[1].toLowerCase() === 'c' ? 2 : 1) * Number(match[2]) / 8;
  return Number.isInteger(bytes) && bytes > 0 ? bytes : null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseSigmfMetadata(bytes) {
  let text;
  try { text = typeof bytes === 'string' ? bytes : decoder.decode(bytes); }
  catch { throw httpError(400, 'Metadata is not valid UTF-8'); }
  let document;
  try { document = JSON.parse(text); }
  catch (error) { throw httpError(400, `Metadata is not valid JSON: ${error.message}`); }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw httpError(400, 'Metadata is not a SigMF object');
  if (!document.global || typeof document.global !== 'object' || Array.isArray(document.global))
    throw httpError(400, 'Metadata has no global object');
  if (document.captures !== undefined && !Array.isArray(document.captures))
    throw httpError(400, 'Metadata captures must be an array');
  if (document.annotations !== undefined && !Array.isArray(document.annotations))
    throw httpError(400, 'Metadata annotations must be an array');
  const datatype = optionalText(document.global['core:datatype'], 64);
  if (!datatype || sigmfBytesPerSample(datatype) === null)
    throw httpError(400, 'Metadata has an invalid core:datatype');
  const captures = Array.isArray(document.captures) ? document.captures : [];
  const frequencyCapture = captures.find(item => finiteNumber(item?.['core:frequency']) !== null);
  return {
    text,
    document,
    summary: {
      datatype,
      sampleRate: finiteNumber(document.global['core:sample_rate']),
      title: optionalText(document.global['grworld:title'], 300),
      author: optionalText(document.global['core:author'], 300),
      description: optionalText(document.global['core:description'], 4000),
      frequency: finiteNumber(frequencyCapture?.['core:frequency']),
    },
  };
}

function validateBaseName(value) {
  const base = optionalText(value, 200);
  if (!base || /[\\/\0-\x1f]/.test(base) || base === '.' || base === '..')
    throw httpError(400, 'Recording has an invalid base name');
  return base.replace(/\.sigmf-(?:data|meta)$/i, '');
}

function optionalHttpUrl(value) {
  const text = optionalText(value, 1000);
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch { throw httpError(400, 'Source URL is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw httpError(400, 'Source URL must use HTTP or HTTPS');
  return parsed.toString();
}

export function validateManifest(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.recordings))
    throw httpError(400, 'recordings must be an array');
  if (!payload.recordings.length || payload.recordings.length > RECORDING_LIMIT)
    throw httpError(400, `A submission must contain 1–${RECORDING_LIMIT} recordings`);
  const seen = new Set();
  let total = 0;
  const recordings = payload.recordings.map(item => {
    const base = validateBaseName(item?.base);
    const folded = base.toLocaleLowerCase();
    if (seen.has(folded)) throw httpError(400, `Duplicate recording base name: ${base}`);
    seen.add(folded);
    const dataSize = Number(item?.dataSize), metaSize = Number(item?.metaSize);
    if (!Number.isSafeInteger(dataSize) || dataSize <= 0 || dataSize > DATA_LIMIT)
      throw httpError(400, `${base}.sigmf-data must be between 1 and ${DATA_LIMIT} bytes`);
    if (!Number.isSafeInteger(metaSize) || metaSize <= 0 || metaSize > META_LIMIT)
      throw httpError(400, `${base}.sigmf-meta must be between 1 and ${META_LIMIT} bytes`);
    total += dataSize + metaSize;
    return { base, dataSize, metaSize };
  });
  if (total > SUBMISSION_LIMIT)
    throw httpError(400, `Submission exceeds ${SUBMISSION_LIMIT} bytes`);
  const contact = payload.contact && typeof payload.contact === 'object' ? payload.contact : {};
  return {
    recordings,
    total,
    publicNotes: optionalText(payload.publicNotes, 4000),
    sourceUrl: optionalHttpUrl(payload.sourceUrl),
    license: optionalText(payload.license, 200),
    contactName: optionalText(contact.name, 200),
    contactEmail: optionalText(contact.email, 320),
    contactHandle: optionalText(contact.handle, 300),
  };
}

async function defaultVerifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET) throw httpError(503, 'Uploads are not configured');
  if (!token || typeof token !== 'string') throw httpError(400, 'Complete the human verification');
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  form.set('idempotency_key', crypto.randomUUID());
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form,
  });
  const result = await response.json();
  if (!result.success) throw httpError(403, 'Human verification failed');
  if (result.hostname && !allowedOrigin(`https://${result.hostname}`, env) &&
      result.hostname !== 'localhost' && result.hostname !== '127.0.0.1')
    throw httpError(403, 'Human verification was issued for another site');
  return true;
}

async function accessJwks(teamDomain) {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.expires > Date.now()) return cached.keys;
  const response = await fetch(teamDomain.replace(/\/+$/, '') + '/cdn-cgi/access/certs');
  if (!response.ok) throw httpError(503, 'Reviewer authentication keys are unavailable');
  const body = await response.json();
  const keys = new Map((body.keys || []).map(key => [key.kid, key]));
  jwksCache.set(teamDomain, { keys, expires: Date.now() + 60 * 60 * 1000 });
  return keys;
}

export async function verifyAccessJwt(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw httpError(401, 'Reviewer sign-in required');
  const pieces = token.split('.');
  if (pieces.length !== 3) throw httpError(401, 'Invalid reviewer token');
  let header, claims;
  try {
    header = JSON.parse(decoder.decode(decodeBase64url(pieces[0])));
    claims = JSON.parse(decoder.decode(decodeBase64url(pieces[1])));
  } catch { throw httpError(401, 'Invalid reviewer token'); }
  if (header.alg !== 'RS256' || !header.kid) throw httpError(401, 'Invalid reviewer token');
  const team = String(env.ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
  if (!team || !env.ACCESS_AUD) throw httpError(503, 'Reviewer authentication is not configured');
  const jwk = (await accessJwks(team)).get(header.kid);
  if (!jwk) throw httpError(401, 'Unknown reviewer signing key');
  const key = await crypto.subtle.importKey('jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    decodeBase64url(pieces[2]), encoder.encode(`${pieces[0]}.${pieces[1]}`));
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!valid || claims.iss !== team || !audiences.includes(env.ACCESS_AUD) ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      (Number.isFinite(claims.nbf) && claims.nbf > now))
    throw httpError(401, 'Invalid or expired reviewer token');
  const email = String(claims.email || '').toLowerCase();
  const admins = String(env.ADMIN_EMAILS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  if (!email || !admins.includes(email)) throw httpError(403, 'Reviewer is not authorized');
  return { email, subject: String(claims.sub || '') };
}

async function submissionRecordings(db, submissionId) {
  const result = await db.prepare(
    'SELECT * FROM recordings WHERE submission_id = ? ORDER BY base_name',
  ).bind(submissionId).all();
  return result.results || [];
}

function publicRecording(row, submission, env) {
  const approved = submission.status === 'approved' && row.production_key;
  const base = approved ? row.production_key : row.data_key.slice(0, -'.sigmf-data'.length);
  const publicId = row.id;
  return {
    id: publicId,
    submissionId: submission.id,
    base,
    virtualKey: `triage/${submission.id}/${row.id}/${row.base_name}`,
    name: row.base_name,
    title: row.title || row.base_name,
    datatype: row.datatype,
    sampleRate: row.sample_rate,
    author: row.author,
    description: row.description,
    frequency: row.frequency,
    byteLength: row.data_size,
    dataUrl: pathUrl(approved ? env.PRODUCTION_PUBLIC_BASE : env.TRIAGE_PUBLIC_BASE,
      approved ? `${row.production_key}.sigmf-data` : row.data_key),
    metadataUrl: pathUrl(approved ? env.PRODUCTION_PUBLIC_BASE : env.TRIAGE_PUBLIC_BASE,
      approved ? `${row.production_key}.sigmf-meta` : row.meta_key),
    productionKey: approved ? row.production_key : null,
  };
}

async function publicSubmission(db, row, env) {
  const recordings = await submissionRecordings(db, row.id);
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    publicNotes: row.public_notes,
    sourceUrl: row.source_url,
    license: row.license,
    recordings: recordings.map(recording => publicRecording(recording, row, env)),
  };
}

async function requireCapability(request, env, submissionId) {
  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(submissionId).first();
  if (!row) throw httpError(404, 'Submission not found');
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token || await sha256(token) !== row.capability_hash) throw httpError(401, 'Invalid upload capability');
  if (row.expires_at <= Date.now() || row.status !== 'uploading')
    throw httpError(409, 'Upload session is no longer active');
  return row;
}

async function recordingForUpload(env, submissionId, recordingId) {
  const row = await env.DB.prepare(
    'SELECT * FROM recordings WHERE id = ? AND submission_id = ?',
  ).bind(recordingId, submissionId).first();
  if (!row) throw httpError(404, 'Recording not found');
  return row;
}

async function createSubmission(request, env, verifyTurnstile) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024)
    throw httpError(413, 'Submission manifest is too large');
  const payload = await request.json().catch(() => { throw httpError(400, 'Request must be JSON'); });
  if (env.CREATE_RATE_LIMITER) {
    const key = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await env.CREATE_RATE_LIMITER.limit({ key })).success) throw httpError(429, 'Too many upload attempts');
  }
  await verifyTurnstile(payload.turnstileToken, request, env);
  const manifest = validateManifest(payload);
  const id = crypto.randomUUID(), capability = randomToken();
  const created = Date.now(), expires = created + UPLOAD_TTL_MS;
  const made = [];
  try {
    for (const item of manifest.recordings) {
      const recordingId = crypto.randomUUID();
      const prefix = `uploads/${id}/${recordingId}`;
      const dataKey = `${prefix}/${item.base}.sigmf-data`;
      const metaKey = `${prefix}/${item.base}.sigmf-meta`;
      const upload = await env.TRIAGE.createMultipartUpload(dataKey, {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { submission: id, recording: recordingId },
      });
      made.push({ ...item, id: recordingId, dataKey, metaKey, uploadId: upload.uploadId });
    }
    const statements = [env.DB.prepare(
      `INSERT INTO submissions
       (id,status,created_at,expires_at,total_bytes,capability_hash,public_notes,source_url,license,
        contact_name,contact_email,contact_handle)
       VALUES (?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, created, expires, manifest.total, await sha256(capability), manifest.publicNotes,
      manifest.sourceUrl, manifest.license, manifest.contactName, manifest.contactEmail,
      manifest.contactHandle)];
    for (const item of made) statements.push(env.DB.prepare(
      `INSERT INTO recordings
       (id,submission_id,base_name,data_key,meta_key,data_size,meta_size,data_upload_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(item.id, id, item.base, item.dataKey, item.metaKey, item.dataSize, item.metaSize,
      item.uploadId));
    await env.DB.batch(statements);
  } catch (error) {
    await Promise.allSettled(made.map(item =>
      env.TRIAGE.resumeMultipartUpload(item.dataKey, item.uploadId).abort()));
    throw error;
  }
  return json({
    submissionId: id,
    capability,
    expiresAt: expires,
    partSize: PART_SIZE,
    recordings: made.map(item => ({
      id: item.id, base: item.base, dataSize: item.dataSize, metaSize: item.metaSize,
      partCount: Math.ceil(item.dataSize / PART_SIZE),
    })),
  }, 201);
}

async function uploadDataPart(request, env, submissionId, recordingId, partNumber) {
  await requireCapability(request, env, submissionId);
  const recording = await recordingForUpload(env, submissionId, recordingId);
  if (recording.data_complete) throw httpError(409, 'Data upload is already complete');
  const count = Math.ceil(recording.data_size / PART_SIZE);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count)
    throw httpError(400, 'Invalid part number');
  const expected = partNumber === count
    ? recording.data_size - PART_SIZE * (count - 1) : PART_SIZE;
  const length = Number(request.headers.get('Content-Length'));
  if (length !== expected) throw httpError(400, `Part must be exactly ${expected} bytes`);
  if (!request.body) throw httpError(400, 'Missing part body');
  const part = await env.TRIAGE
    .resumeMultipartUpload(recording.data_key, recording.data_upload_id)
    .uploadPart(partNumber, request.body);
  return json(part);
}

async function completeData(request, env, submissionId, recordingId) {
  await requireCapability(request, env, submissionId);
  const recording = await recordingForUpload(env, submissionId, recordingId);
  if (recording.data_complete) return json({ ok: true, alreadyComplete: true });
  const alreadyStored = await env.TRIAGE.head(recording.data_key);
  if (alreadyStored) {
    if (alreadyStored.size !== recording.data_size)
      throw httpError(409, 'Stored data size does not match the manifest');
    await env.DB.prepare('UPDATE recordings SET data_complete = 1 WHERE id = ?')
      .bind(recording.id).run();
    return json({ ok: true, alreadyComplete: true });
  }
  const body = await request.json().catch(() => { throw httpError(400, 'Request must be JSON'); });
  const count = Math.ceil(recording.data_size / PART_SIZE);
  if (!Array.isArray(body.parts) || body.parts.length !== count)
    throw httpError(400, `Expected ${count} uploaded parts`);
  const parts = body.parts.map(part => ({ partNumber: Number(part.partNumber), etag: String(part.etag || '') }))
    .sort((a, b) => a.partNumber - b.partNumber);
  if (parts.some((part, index) => part.partNumber !== index + 1 || !part.etag))
    throw httpError(400, 'Uploaded parts are incomplete');
  await env.TRIAGE.resumeMultipartUpload(recording.data_key, recording.data_upload_id).complete(parts);
  const object = await env.TRIAGE.head(recording.data_key);
  if (!object || object.size !== recording.data_size) {
    await env.TRIAGE.delete(recording.data_key);
    throw httpError(400, 'Completed data size does not match the manifest');
  }
  await env.DB.prepare('UPDATE recordings SET data_complete = 1 WHERE id = ?').bind(recording.id).run();
  return json({ ok: true });
}

async function uploadMetadata(request, env, submissionId, recordingId) {
  await requireCapability(request, env, submissionId);
  const recording = await recordingForUpload(env, submissionId, recordingId);
  const length = Number(request.headers.get('Content-Length'));
  if (length !== recording.meta_size || length > META_LIMIT)
    throw httpError(400, `Metadata must be exactly ${recording.meta_size} bytes`);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== recording.meta_size) throw httpError(400, 'Metadata size does not match the manifest');
  const parsed = parseSigmfMetadata(bytes);
  await env.TRIAGE.put(recording.meta_key, bytes, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache' },
    customMetadata: { submission: submissionId, recording: recordingId },
  });
  const summary = parsed.summary;
  await env.DB.prepare(
    `UPDATE recordings SET meta_complete=1, datatype=?, sample_rate=?, title=?, author=?,
     description=?, frequency=? WHERE id=?`,
  ).bind(summary.datatype, summary.sampleRate, summary.title, summary.author, summary.description,
    summary.frequency, recording.id).run();
  return json({ ok: true, summary });
}

async function completeSubmission(request, env, submissionId) {
  const submission = await requireCapability(request, env, submissionId);
  const recordings = await submissionRecordings(env.DB, submissionId);
  if (!recordings.length || recordings.some(row => !row.data_complete || !row.meta_complete))
    throw httpError(409, 'Every data and metadata file must finish first');
  for (const row of recordings) {
    const data = await env.TRIAGE.head(row.data_key);
    const meta = await env.TRIAGE.get(row.meta_key);
    if (!data || data.size !== row.data_size || !meta || meta.size !== row.meta_size)
      throw httpError(409, `Uploaded files for ${row.base_name} are incomplete`);
    const parsed = parseSigmfMetadata(new Uint8Array(await meta.arrayBuffer()));
    const bytesPerSample = sigmfBytesPerSample(parsed.summary.datatype);
    if (row.data_size % bytesPerSample !== 0)
      throw httpError(400, `${row.base_name}.sigmf-data is not aligned to ${parsed.summary.datatype} samples`);
  }
  await env.DB.prepare(
    `UPDATE submissions SET status='ready', expires_at=? WHERE id=? AND status='uploading'`,
  ).bind(Date.now() + TRIAGE_TTL_MS, submission.id).run();
  const ready = await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(submission.id).first();
  return json({ ok: true, submission: await publicSubmission(env.DB, ready, env) });
}

async function cancelSubmission(request, env, submissionId) {
  const submission = await requireCapability(request, env, submissionId);
  const recordings = await submissionRecordings(env.DB, submissionId);
  await Promise.allSettled(recordings.map(async row => {
    if (!row.data_complete) {
      try { await env.TRIAGE.resumeMultipartUpload(row.data_key, row.data_upload_id).abort(); }
      catch { /* it may already have completed; the object delete below is authoritative */ }
    }
    await env.TRIAGE.delete([row.data_key, row.meta_key]);
  }));
  await env.DB.prepare(
    `UPDATE submissions SET status='expired', contact_name='', contact_email='', contact_handle=''
     WHERE id=?`,
  ).bind(submission.id).run();
  return new Response(null, { status: 204 });
}

async function listTriage(url, env) {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
  const result = await env.DB.prepare(
    `SELECT * FROM submissions WHERE status='ready' ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit + 1, offset).all();
  const rows = result.results || [];
  const page = rows.slice(0, limit);
  return json({
    submissions: await Promise.all(page.map(row => publicSubmission(env.DB, row, env))),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  }, 200, { 'Cache-Control': 'no-store' });
}

async function getTriageSubmission(env, id) {
  const row = await env.DB.prepare(
    `SELECT * FROM submissions WHERE id=? AND status IN ('ready','approved')`,
  ).bind(id).first();
  if (!row) throw httpError(404, 'Triage submission not found');
  return json({ submission: await publicSubmission(env.DB, row, env) }, 200,
    { 'Cache-Control': 'no-store' });
}

async function getTriageRecording(env, id) {
  const row = await env.DB.prepare(
    `SELECT r.*, s.status, s.id AS submission_id, s.created_at, s.expires_at,
            s.public_notes, s.source_url, s.license
     FROM recordings r JOIN submissions s ON s.id=r.submission_id
     WHERE r.id=? AND s.status IN ('ready','approved')`,
  ).bind(id).first();
  if (!row) throw httpError(404, 'Triage recording not found');
  const submission = { id: row.submission_id, status: row.status };
  return json({ recording: publicRecording(row, submission, env) }, 200,
    { 'Cache-Control': 'no-store' });
}

async function adminSubmission(env, id) {
  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(id).first();
  if (!row) throw httpError(404, 'Submission not found');
  return {
    ...(await publicSubmission(env.DB, row, env)),
    contact: { name: row.contact_name, email: row.contact_email, handle: row.contact_handle },
    reviewedAt: row.reviewed_at,
    reviewerEmail: row.reviewer_email,
    reviewReason: row.review_reason,
  };
}

async function listAdmin(url, env) {
  const status = url.searchParams.get('status') || 'ready';
  if (!['uploading', 'ready', 'approving', 'approved', 'rejected', 'expired'].includes(status))
    throw httpError(400, 'Invalid status');
  const result = await env.DB.prepare(
    'SELECT id FROM submissions WHERE status=? ORDER BY created_at DESC LIMIT 100',
  ).bind(status).all();
  return json({ submissions: await Promise.all((result.results || []).map(row => adminSubmission(env, row.id))) });
}

function productionKey(value) {
  const key = String(value || '').replace(/\\/g, '/').replace(/\.sigmf-(?:data|meta)$/i, '');
  const segments = key.split('/');
  if (!key || key.length > 900 || segments.some(segment => !segment || segment === '.' || segment === '..'))
    throw httpError(400, 'Invalid production key');
  return key;
}

async function copyIfNeeded(sourceBucket, targetBucket, sourceKey, targetKey, expectedSize,
                            metadata, owner) {
  const existing = await targetBucket.head(targetKey);
  if (existing) {
    if (existing.size !== expectedSize ||
        existing.customMetadata?.triageSubmission !== owner.submission ||
        existing.customMetadata?.triageRecording !== owner.recording)
      throw httpError(409, `Production object already exists: ${targetKey}`);
    return;
  }
  const source = await sourceBucket.get(sourceKey);
  if (!source || source.size !== expectedSize) throw httpError(409, `Triage object is unavailable: ${sourceKey}`);
  await targetBucket.put(targetKey, source.body, {
    httpMetadata: metadata,
    customMetadata: {
      triageSubmission: owner.submission,
      triageRecording: owner.recording,
    },
  });
}

async function approveSubmission(request, env, id, reviewer) {
  const body = await request.json().catch(() => { throw httpError(400, 'Request must be JSON'); });
  if (body.confirm !== 'approve') throw httpError(400, 'Approval confirmation is required');
  const submission = await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(id).first();
  if (!submission || !['ready', 'approving'].includes(submission.status))
    throw httpError(409, 'Submission is not ready for approval');
  const recordings = await submissionRecordings(env.DB, id);
  const requested = new Map((Array.isArray(body.recordings) ? body.recordings : [])
    .map(item => [String(item.id), productionKey(item.productionKey)]));
  if (requested.size !== recordings.length || recordings.some(row => !requested.has(row.id)))
    throw httpError(400, 'Supply one production key for every recording');
  if (new Set(requested.values()).size !== requested.size)
    throw httpError(400, 'Production keys must be unique');
  await env.DB.prepare(`UPDATE submissions SET status='approving' WHERE id=?`).bind(id).run();
  try {
    for (const row of recordings) {
      const parsedMeta = await env.TRIAGE.get(row.meta_key);
      if (!parsedMeta) throw httpError(409, `Metadata for ${row.base_name} is unavailable`);
      parseSigmfMetadata(new Uint8Array(await parsedMeta.arrayBuffer()));
      const key = requested.get(row.id);
      const owner = { submission: id, recording: row.id };
      await copyIfNeeded(env.TRIAGE, env.PRODUCTION, row.data_key, `${key}.sigmf-data`, row.data_size,
        { contentType: 'application/octet-stream' }, owner);
      // Metadata last: the production catalog never sees a complete pair before
      // the much larger data object is safely in place.
      await copyIfNeeded(env.TRIAGE, env.PRODUCTION, row.meta_key, `${key}.sigmf-meta`, row.meta_size,
        { contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache' }, owner);
      await env.DB.prepare('UPDATE recordings SET production_key=? WHERE id=?').bind(key, row.id).run();
    }
  } catch (error) {
    // A retry is safe: objects already copied by this submission carry owner
    // metadata and copyIfNeeded accepts only that exact match.
    await env.DB.prepare(`UPDATE submissions SET status='ready' WHERE id=? AND status='approving'`)
      .bind(id).run();
    throw error;
  }
  const now = Date.now();
  const reviewReason = optionalText(body.reason, 1000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE submissions SET status='approved', reviewed_at=?, reviewer_email=?, review_reason=? WHERE id=?`,
    ).bind(now, reviewer.email, reviewReason, id),
    env.DB.prepare(
      `INSERT INTO review_events (submission_id,created_at,reviewer_email,action,reason,details_json)
       VALUES (?, ?, ?, 'approve', ?, ?)`,
    ).bind(id, now, reviewer.email, reviewReason,
      JSON.stringify(recordings.map(row => ({ id: row.id, productionKey: requested.get(row.id) })))),
  ]);
  const deleted = await Promise.allSettled(
    recordings.map(row => env.TRIAGE.delete([row.data_key, row.meta_key])));
  if (deleted.every(result => result.status === 'fulfilled'))
    await env.DB.prepare('UPDATE submissions SET triage_cleaned_at=? WHERE id=?').bind(Date.now(), id).run();
  console.log('Recording submission approved', { submission_id: id, reviewer: reviewer.email });
  return json({ ok: true, submission: await adminSubmission(env, id) });
}

async function rejectSubmission(request, env, id, reviewer) {
  const body = await request.json().catch(() => { throw httpError(400, 'Request must be JSON'); });
  if (body.confirm !== 'reject') throw httpError(400, 'Rejection confirmation is required');
  const reason = optionalText(body.reason, 1000);
  if (!reason) throw httpError(400, 'A rejection reason is required');
  const submission = await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(id).first();
  if (!submission || !['uploading', 'ready'].includes(submission.status))
    throw httpError(409, 'Submission cannot be rejected in its current state');
  const recordings = await submissionRecordings(env.DB, id);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE submissions SET status='rejected', reviewed_at=?, reviewer_email=?, review_reason=? WHERE id=?`,
    ).bind(now, reviewer.email, reason, id),
    env.DB.prepare(
      `INSERT INTO review_events (submission_id,created_at,reviewer_email,action,reason,details_json)
       VALUES (?, ?, ?, 'reject', ?, '{}')`,
    ).bind(id, now, reviewer.email, reason),
  ]);
  const deleted = await Promise.allSettled(recordings.map(async row => {
    if (!row.data_complete) {
      try { await env.TRIAGE.resumeMultipartUpload(row.data_key, row.data_upload_id).abort(); }
      catch { /* a completed multipart upload has nothing left to abort */ }
    }
    await env.TRIAGE.delete([row.data_key, row.meta_key]);
  }));
  if (deleted.every(result => result.status === 'fulfilled'))
    await env.DB.prepare('UPDATE submissions SET triage_cleaned_at=? WHERE id=?').bind(Date.now(), id).run();
  console.log('Recording submission rejected', { submission_id: id, reviewer: reviewer.email });
  return json({ ok: true, submission: await adminSubmission(env, id) });
}

async function cleanup(env) {
  const now = Date.now();
  const expired = await env.DB.prepare(
    `SELECT id FROM submissions WHERE status IN ('uploading','ready') AND expires_at < ? LIMIT 100`,
  ).bind(now).all();
  for (const item of expired.results || []) {
    const recordings = await submissionRecordings(env.DB, item.id);
    await Promise.allSettled(recordings.map(async row => {
      if (!row.data_complete) {
        try { await env.TRIAGE.resumeMultipartUpload(row.data_key, row.data_upload_id).abort(); }
        catch { /* a completed multipart upload has nothing left to abort */ }
      }
      await env.TRIAGE.delete([row.data_key, row.meta_key]);
    }));
    await env.DB.prepare(
      `UPDATE submissions SET status='expired', contact_name='', contact_email='', contact_handle=''
       WHERE id=?`,
    ).bind(item.id).run();
  }
  // Approval/rejection already tries these deletes. Retrying them from the
  // cron makes a transient R2 failure self-healing without delaying the review
  // response or retaining duplicate objects indefinitely.
  const reviewed = await env.DB.prepare(
    `SELECT id FROM submissions WHERE status IN ('approved','rejected')
     AND reviewed_at < ? AND triage_cleaned_at IS NULL LIMIT 100`,
  ).bind(now - 24 * 60 * 60 * 1000).all();
  for (const item of reviewed.results || []) {
    const recordings = await submissionRecordings(env.DB, item.id);
    const deleted = await Promise.allSettled(
      recordings.map(row => env.TRIAGE.delete([row.data_key, row.meta_key])));
    if (deleted.every(result => result.status === 'fulfilled'))
      await env.DB.prepare('UPDATE submissions SET triage_cleaned_at=? WHERE id=?')
        .bind(now, item.id).run();
  }
  await env.DB.prepare(
    `UPDATE submissions SET contact_name='', contact_email='', contact_handle=''
     WHERE reviewed_at IS NOT NULL AND reviewed_at < ?`,
  ).bind(now - CONTACT_RETENTION_MS).run();
  return { expired: (expired.results || []).length, reviewedCleaned: (reviewed.results || []).length };
}

export function createApp({ verifyTurnstile = defaultVerifyTurnstile, verifyAdmin = verifyAccessJwt } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const admin = url.pathname.startsWith('/v1/admin/');
      if (request.method === 'OPTIONS') {
        if (request.headers.get('Origin') && !allowedOrigin(request.headers.get('Origin'), env))
          return json({ error: 'Origin not allowed' }, 403);
        return new Response(null, { status: 204, headers: corsHeaders(request, env, admin) });
      }
      try {
        let response;
        let match;
        if (request.method === 'POST' && url.pathname === '/v1/submissions')
          response = await createSubmission(request, env, verifyTurnstile);
        else if ((match = /^\/v1\/submissions\/([^/]+)\/recordings\/([^/]+)\/data\/parts\/(\d+)$/.exec(url.pathname)) && request.method === 'PUT')
          response = await uploadDataPart(request, env, match[1], match[2], Number(match[3]));
        else if ((match = /^\/v1\/submissions\/([^/]+)\/recordings\/([^/]+)\/data\/complete$/.exec(url.pathname)) && request.method === 'POST')
          response = await completeData(request, env, match[1], match[2]);
        else if ((match = /^\/v1\/submissions\/([^/]+)\/recordings\/([^/]+)\/meta$/.exec(url.pathname)) && request.method === 'PUT')
          response = await uploadMetadata(request, env, match[1], match[2]);
        else if ((match = /^\/v1\/submissions\/([^/]+)\/complete$/.exec(url.pathname)) && request.method === 'POST')
          response = await completeSubmission(request, env, match[1]);
        else if ((match = /^\/v1\/submissions\/([^/]+)$/.exec(url.pathname)) && request.method === 'DELETE')
          response = await cancelSubmission(request, env, match[1]);
        else if (request.method === 'GET' && url.pathname === '/v1/triage')
          response = await listTriage(url, env);
        else if ((match = /^\/v1\/triage\/recordings\/([^/]+)$/.exec(url.pathname)) && request.method === 'GET')
          response = await getTriageRecording(env, match[1]);
        else if ((match = /^\/v1\/triage\/([^/]+)$/.exec(url.pathname)) && request.method === 'GET')
          response = await getTriageSubmission(env, match[1]);
        else if (admin) {
          const origin = request.headers.get('Origin');
          if (!['GET', 'HEAD'].includes(request.method) && origin && !allowedOrigin(origin, env))
            throw httpError(403, 'Origin not allowed');
          const reviewer = await verifyAdmin(request, env);
          if (request.method === 'GET' && url.pathname === '/v1/admin/session') {
            const returnTo = url.searchParams.get('return');
            if (returnTo) {
              let target;
              try { target = new URL(returnTo); } catch { throw httpError(400, 'Invalid return URL'); }
              if (!allowedOrigin(target.origin, env)) throw httpError(400, 'Return URL is not allowed');
              response = Response.redirect(target.toString(), 302);
            } else response = json({ ok: true, reviewer: reviewer.email });
          }
          else if (request.method === 'GET' && url.pathname === '/v1/admin/submissions')
            response = await listAdmin(url, env);
          else if ((match = /^\/v1\/admin\/submissions\/([^/]+)$/.exec(url.pathname)) && request.method === 'GET')
            response = json({ submission: await adminSubmission(env, match[1]) });
          else if ((match = /^\/v1\/admin\/submissions\/([^/]+)\/approve$/.exec(url.pathname)) && request.method === 'POST')
            response = await approveSubmission(request, env, match[1], reviewer);
          else if ((match = /^\/v1\/admin\/submissions\/([^/]+)\/reject$/.exec(url.pathname)) && request.method === 'POST')
            response = await rejectSubmission(request, env, match[1], reviewer);
          else response = json({ error: 'Not found' }, 404);
        } else response = json({ error: 'Not found' }, 404);
        return withCors(response, request, env, admin);
      } catch (error) {
        const status = Number(error?.status) || 500;
        if (status >= 500) console.error('SigMF upload request failed', error);
        return withCors(json({ error: status === 500 ? 'Internal error' : error.message }, status), request, env, admin);
      }
    },
    async scheduled(_controller, env) {
      const result = await cleanup(env);
      console.log('Recording submission cleanup completed', result);
    },
  };
}

export default createApp();
