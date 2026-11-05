import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request } from 'express';
import { config } from './config.js';
import { one, query } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';

/**
 * The document store: files kept once by SHA-256 under FILE_STORE (sha[0..2]/sha[2..4]/sha), and a row
 * per attachment. A removed document is hidden from the card but its file stays on disk.
 */
const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 15 * 1024 * 1024);
const ALLOWED = (process.env.ALLOWED_MIME || [
  'application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'image/heic', 'text/plain', 'text/csv',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'].join(',')).split(',').map(s => s.trim());

export type OwnerType = 'PRODUCT' | 'RT_PERMIT' | 'PARTNER' | 'DECLARATION' | 'INVOICE';
const PUBLIC_COLS = 'id, owner_type, owner_id, doc_code, filename, mime, size_bytes, sha256, uploaded_at, uploaded_by';

export async function store(req: Request, owner: { type: OwnerType; id: string }, b: { filename?: string; mime?: string; contentBase64?: string; docCode?: string }) {
  const buffer = Buffer.from(String(b.contentBase64 || ''), 'base64');
  if (!buffer.length) fail(400, 'Filen er tom.');
  if (buffer.length > MAX_BYTES) fail(413, `Filen er større enn grensen på ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);
  const mime = b.mime ? String(b.mime) : null;
  if (mime && !ALLOWED.includes(mime)) fail(415, `Filtypen ${mime} godtas ikke.`);
  const filename = String(b.filename || 'dokument').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200);
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const rel = path.join(sha.slice(0, 2), sha.slice(2, 4), sha);
  const abs = path.join(config.fileStore, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buffer, { mode: 0o640 });
  const row = (await one(`INSERT INTO document (owner_type, owner_id, doc_code, filename, mime, size_bytes, sha256, storage_path, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${PUBLIC_COLS}`,
    [owner.type, owner.id, b.docCode ? String(b.docCode).slice(0, 20) : null, filename, mime, buffer.length, sha, rel, req.user!.id]))!;
  await audit(req, { action: 'DOCUMENT_STORED', objectType: owner.type === 'RT_PERMIT' ? 'PRODUCT' : owner.type, objectId: owner.id,
    detail: { document: row.id, filename, docCode: b.docCode ?? null, sha256: sha, bytes: buffer.length } });
  return row;
}

export const listFor = (type: OwnerType, id: string) =>
  query(`SELECT d.id, d.doc_code, d.filename, d.mime, d.size_bytes, d.uploaded_at, u.name uploaded_by_name FROM document d
      LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.owner_type = $1 AND d.owner_id = $2 AND d.removed_at IS NULL ORDER BY d.uploaded_at`, [type, id]);

/** The file, checked against its SHA-256 before it is handed out. */
export async function read(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const d = await one('SELECT * FROM document WHERE id = $1', [id]);
  if (!d) return null;
  const buffer = fs.readFileSync(path.join(config.fileStore, d.storage_path));
  const intact = crypto.createHash('sha256').update(buffer).digest('hex') === d.sha256;
  return { ...d, buffer, intact };
}

export async function remove(req: Request, id: string) {
  const d = await one('SELECT * FROM document WHERE id = $1 AND removed_at IS NULL', [id]);
  if (!d) fail(404, 'Fant ikke dokumentet.');
  await query('UPDATE document SET removed_at = now(), removed_by = $2 WHERE id = $1', [id, req.user!.id]);
  await audit(req, { action: 'DOCUMENT_REMOVED', objectType: d!.owner_type === 'RT_PERMIT' ? 'PRODUCT' : d!.owner_type, objectId: d!.owner_id, detail: { document: id, filename: d!.filename } });
  return { ok: true };
}
