import { extname } from 'node:path';
import express, { type RequestHandler } from 'express';
import multer from 'multer';
import { QueryError } from '../queries/errors.js';
import { documentExtensions, extractDocument } from './documents.js';

const maxFileBytes = 1024 * 1024;
const extensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.yaml', '.yml']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileBytes + 1, files: 1, fields: 0, parts: 2 },
  fileFilter: (_request, file, done) => {
    const extension = extname(file.originalname).toLowerCase();
    if (!extensions.has(extension) && !documentExtensions.has(extension)) {
      done(new QueryError(415, 'unsupported_file_type', 'Supported files: TXT, Markdown, CSV, TSV, JSON, JSONL, YAML, PDF, DOCX, and DOC.'));
      return;
    }
    done(null, true);
  },
}).single('file');
const json = express.json({ limit: '1mb' });

// Parse sources before opening a database transaction. Uploaded bytes never touch disk.
export const parseSource: RequestHandler = (request, response, next) => {
  if (request.is('application/json')) {
    json(request, response, next);
    return;
  }
  if (!request.is('multipart/form-data')) {
    next(new QueryError(415, 'unsupported_media_type', 'Use application/json or multipart/form-data with one file field.'));
    return;
  }
  upload(request, response, async error => {
    if (error) {
      if (error instanceof QueryError) next(error);
      else if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(new QueryError(413, 'payload_too_large', 'File must not exceed 1 MiB.'));
      } else {
        next(new QueryError(400, 'invalid_upload', 'Send exactly one file in the file field, without additional fields.'));
      }
      return;
    }
    if (!request.file) {
      next(new QueryError(400, 'invalid_upload', 'Send exactly one file in the file field.'));
      return;
    }
    if (request.file.buffer.length > maxFileBytes) {
      next(new QueryError(413, 'payload_too_large', 'File must not exceed 1 MiB.'));
      return;
    }
    const controller = new AbortController();
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', onClose);
    try {
      request.body = { text: await decodeSource(request.file.buffer, request.file.originalname, controller.signal) };
      next();
    } catch (error) {
      next(error);
    } finally {
      response.removeListener('close', onClose);
    }
  });
};

export function sourceText(body: unknown): string {
  const text = (body as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string' || !text.trim() || text.includes('\0')) {
    throw new QueryError(400, 'invalid_text', 'text must be a non-empty string without null characters.');
  }
  return text;
}

// Shared by multipart uploads and Telegram document messages.
export async function decodeSource(buffer: Buffer, filename: string, signal = new AbortController().signal) {
  if (buffer.length > maxFileBytes) throw new QueryError(413, 'payload_too_large', 'File must not exceed 1 MiB.');
  const extension = extname(filename).toLowerCase();
  if (documentExtensions.has(extension)) return sourceText({ text: await extractDocument(buffer, extension, signal) });
  if (!extensions.has(extension)) throw new QueryError(415, 'unsupported_file_type', 'Unsupported file format.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new QueryError(400, 'invalid_file_encoding', 'File must contain valid UTF-8 text.');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new QueryError(400, 'invalid_text', 'File must contain text without binary control characters.');
  }
  return sourceText({ text });
}
