import { extname } from 'node:path';
import express, { type RequestHandler } from 'express';
import multer from 'multer';
import { QueryError } from '../queries/errors.js';
import { documentExtensions, extractDocument } from './documents.js';

import { imageExtensions, isImage, normalizeImage } from './images.js';

import { uploadLimits } from './limits.js';

const maxFileBytes = uploadLimits.fileBytes;
const extensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.yaml', '.yml']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileBytes + 1, files: 1, fields: 0, parts: 2 },
  fileFilter: (_request, file, done) => {
    const extension = extname(file.originalname).toLowerCase();
    if (!extensions.has(extension) && !documentExtensions.has(extension) && !imageExtensions.has(extension)) {
      done(new QueryError(415, 'unsupported_file_type', 'Supported files: TXT, Markdown, CSV, TSV, JSON, JSONL, YAML, PDF, DOCX, DOC, JPEG, PNG, and WebP.'));
      return;
    }
    done(null, true);
  },
}).single('file');
const json = express.json({ limit: '1mb' });

// Parse sources before opening a database transaction. Uploaded bytes never touch disk.
let activeUploads = 0;

export const parseSource: RequestHandler = (request, response, next) => {
  if (request.is('application/json')) {
    json(request, response, next);
    return;
  }
  if (!request.is('multipart/form-data')) {
    next(new QueryError(415, 'unsupported_media_type', 'Use application/json or multipart/form-data with one file field.'));
    return;
  }
  if (activeUploads >= uploadLimits.httpUploads) {
    next(new QueryError(429, 'upload_capacity_full', 'File upload capacity is full. Try again later.'));
    return;
  }
  activeUploads++;
  let parsingFinished = false, responseFinished = false, released = false;
  const release = () => {
    if (!released && parsingFinished && responseFinished) { released = true; activeUploads--; }
  };
  response.once('close', () => { responseFinished = true; release(); });
  response.once('finish', () => { responseFinished = true; release(); });
  upload(request, response, async error => {
    try {
      if (error) {
        if (error instanceof QueryError) next(error);
        else if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          next(new QueryError(413, 'payload_too_large', 'File must not exceed 20 MB.'));
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
        next(new QueryError(413, 'payload_too_large', 'File must not exceed 20 MB.'));
        return;
      }
      const controller = new AbortController();
      const onClose = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', onClose);
      try {
        if (isImage(request.file.originalname)) {
          await normalizeImage(request.file.buffer, request.file.originalname, controller.signal);
          request.body = { image: { bytes: request.file.buffer, filename: request.file.originalname } };
        } else request.body = { text: await decodeSource(request.file.buffer, request.file.originalname, controller.signal) };
        next();
      } catch (error) {
        next(error);
      } finally {
        response.removeListener('close', onClose);
      }
    } finally { parsingFinished = true; release(); }
  });
};

export function sourceText(body: unknown): string {
  const text = (body as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string' || !text.trim() || text.includes('\0')) {
    throw new QueryError(400, 'invalid_text', 'text must be a non-empty string without null characters.');
  }
  if (Buffer.byteLength(text) > uploadLimits.textBytes) {
    throw new QueryError(413, 'extracted_text_too_large', 'Extracted text must not exceed 5 MiB.');
  }
  return text;
}

// Shared by multipart uploads and Telegram document messages.
export async function decodeSource(buffer: Buffer, filename: string, signal = new AbortController().signal) {
  if (buffer.length > maxFileBytes) throw new QueryError(413, 'payload_too_large', 'File must not exceed 20 MB.');
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

export function validateSourceFilename(filename: string) {
  const extension = extname(filename).toLowerCase();
  if (!extensions.has(extension) && !documentExtensions.has(extension) && !imageExtensions.has(extension)) {
    throw new QueryError(415, 'unsupported_file_type', 'Unsupported file format.');
  }
}
