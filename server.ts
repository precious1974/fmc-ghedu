import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import express, {type NextFunction, type Request, type Response} from 'express';
import multer from 'multer';

const PORT = 3000;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB per file
const MAX_FILES_PER_UPLOAD = 20;
const BUCKET_NAME = 'pocketvault-files';
const TEMP_UPLOAD_DIR = path.resolve(os.tmpdir(), 'pocketvault-uploads');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FileCategory = 'documents' | 'images' | 'media' | 'archives' | 'other';

interface DbFileRow {
  id: string;
  original_name: string;
  storage_path: string;
  extension: string;
  size: number;
  mime_type: string;
  category: FileCategory;
  previewable: boolean;
  uploaded_at: string;
}

const SAFE_IMAGE_PREVIEW_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const SAFE_TEXT_PREVIEW_MIMES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
]);

fs.mkdirSync(TEMP_UPLOAD_DIR, {recursive: true});

let cachedClient: SupabaseClient | null = null;
let cachedKeySignature = '';

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();

  if (!url || !key) {
    return null;
  }

  const signature = `${url}|${key}`;
  if (!cachedClient || cachedKeySignature !== signature) {
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    cachedKeySignature = signature;
  }

  return cachedClient;
}

function sanitizeOriginalFilename(rawName: string): string {
  const base = path.basename(rawName || 'untitled').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!base || base === '.' || base === '..') {
    return 'untitled';
  }
  return base.slice(0, 255);
}

function inferCategory(mimeType: string, extension: string): FileCategory {
  const lowerMime = mimeType.toLowerCase();
  const ext = extension.toLowerCase();

  if (lowerMime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'].includes(ext)) {
    return 'images';
  }
  if (
    lowerMime.startsWith('video/') ||
    lowerMime.startsWith('audio/') ||
    ['.mp4', '.mov', '.webm', '.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)
  ) {
    return 'media';
  }
  if (
    ['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz'].includes(ext) ||
    lowerMime.includes('zip') ||
    lowerMime.includes('compressed') ||
    lowerMime.includes('archive')
  ) {
    return 'archives';
  }
  if (
    lowerMime.startsWith('text/') ||
    lowerMime === 'application/pdf' ||
    lowerMime === 'application/json' ||
    ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.json', '.rtf'].includes(ext)
  ) {
    return 'documents';
  }
  return 'other';
}

function isPreviewable(mimeType: string, extension: string): boolean {
  const lower = mimeType.toLowerCase();
  if (SAFE_IMAGE_PREVIEW_MIMES.has(lower)) {
    return true;
  }
  if (SAFE_TEXT_PREVIEW_MIMES.has(lower)) {
    return true;
  }
  if (lower === 'application/octet-stream' && ['.txt', '.md', '.csv', '.json', '.log'].includes(extension.toLowerCase())) {
    return true;
  }
  return false;
}

function toPublicItem(row: DbFileRow) {
  return {
    id: row.id,
    originalName: row.original_name,
    extension: row.extension,
    size: Number(row.size),
    mimeType: row.mime_type,
    category: row.category,
    uploadedAt: row.uploaded_at,
    previewable: row.previewable,
  };
}

function buildContentDisposition(filename: string, disposition: 'attachment' | 'inline'): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(TEMP_UPLOAD_DIR, {recursive: true});
    cb(null, TEMP_UPLOAD_DIR);
  },
  filename: (_req, _file, cb) => {
    cb(null, crypto.randomUUID());
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_UPLOAD,
  },
});

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/api/health', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(503).json({ok: false, configured: false, database: false, storage: false});
      return;
    }

    const [dbCheck, storageCheck] = await Promise.all([
      supabase.from('files').select('id', {count: 'exact', head: true}),
      supabase.storage.from(BUCKET_NAME).list('', {limit: 1}),
    ]);

    const databaseOk = !dbCheck.error;
    const storageOk = !storageCheck.error;

    res.status(databaseOk && storageOk ? 200 : 502).json({
      ok: databaseOk && storageOk,
      configured: true,
      database: databaseOk,
      storage: storageOk,
    });
  });

  app.get('/api/files', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(503).json({
        error: 'Supabase is not configured yet. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Settings → Secrets.',
        code: 'SUPABASE_NOT_CONFIGURED',
      });
      return;
    }

    const {data, error} = await supabase
      .from('files')
      .select('id, original_name, storage_path, extension, size, mime_type, category, previewable, uploaded_at')
      .order('uploaded_at', {ascending: false});

    if (error) {
      console.error('Supabase list error:', error.message);
      res.status(502).json({error: 'Could not load files from Supabase. Verify your schema and policies.'});
      return;
    }

    const rows = (data ?? []) as DbFileRow[];
    const files = rows.map(toPublicItem);
    const totalBytes = files.reduce((sum, item) => sum + item.size, 0);

    res.json({
      files,
      totalBytes,
    });
  });

  app.post('/api/files/upload', upload.any(), async (req: Request, res: Response) => {
    const uploadedFiles = req.files as Express.Multer.File[] | undefined;
    const supabase = getSupabaseClient();

    const cleanupTempFiles = async () => {
      if (!uploadedFiles) {
        return;
      }
      await Promise.all(
        uploadedFiles.map((file) => {
          const resolved = path.resolve(file.path);
          if (resolved.startsWith(TEMP_UPLOAD_DIR + path.sep)) {
            return fsp.unlink(resolved).catch(() => undefined);
          }
          return Promise.resolve();
        }),
      );
    };

    try {
      if (!supabase) {
        res.status(503).json({
          error: 'Supabase is not configured yet. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Settings → Secrets.',
          code: 'SUPABASE_NOT_CONFIGURED',
        });
        return;
      }

      if (!uploadedFiles || uploadedFiles.length === 0) {
        res.status(400).json({error: 'No files were provided in the upload request.'});
        return;
      }

      const createdItems = [];

      for (const file of uploadedFiles) {
        const resolvedTemp = path.resolve(file.path);
        if (!resolvedTemp.startsWith(TEMP_UPLOAD_DIR + path.sep)) {
          res.status(400).json({error: 'Invalid temporary upload path.'});
          return;
        }

        const originalName = sanitizeOriginalFilename(file.originalname);
        const rawExt = path.extname(originalName);
        const ext = rawExt.replace(/^\./, '').toUpperCase().slice(0, 16) || 'FILE';
        const mimeType = file.mimetype || 'application/octet-stream';
        const category = inferCategory(mimeType, rawExt);
        const previewable = isPreviewable(mimeType, rawExt);
        const fileId = crypto.randomUUID();
        const storagePath = fileId;

        const buffer = await fsp.readFile(resolvedTemp);

        const {error: storageError} = await supabase.storage
          .from(BUCKET_NAME)
          .upload(storagePath, buffer, {
            contentType: mimeType,
            upsert: false,
          });

        if (storageError) {
          console.error('Supabase storage upload error:', storageError.message);
          res.status(502).json({
            error: `Failed to store "${originalName}" in Supabase Storage: ${storageError.message}`,
          });
          return;
        }

        const {data: insertedRow, error: dbError} = await supabase
          .from('files')
          .insert({
            id: fileId,
            original_name: originalName,
            storage_path: storagePath,
            extension: ext,
            size: file.size,
            mime_type: mimeType,
            category,
            previewable,
          })
          .select('id, original_name, storage_path, extension, size, mime_type, category, previewable, uploaded_at')
          .single();

        if (dbError || !insertedRow) {
          console.error('Supabase insert error:', dbError?.message);
          res.status(502).json({
            error: `Uploaded "${originalName}", but failed to save metadata in the files table: ${dbError?.message ?? 'unknown error'}`,
          });
          return;
        }

        createdItems.push(toPublicItem(insertedRow as DbFileRow));
      }

      res.status(201).json({files: createdItems});
    } finally {
      await cleanupTempFiles();
    }
  });

  app.get('/api/files/:id/download', async (req: Request, res: Response) => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(503).json({error: 'Supabase is not configured.'});
      return;
    }

    const id = String(req.params.id || '');
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({error: 'Invalid file identifier.'});
      return;
    }

    const {data: row, error: fetchError} = await supabase
      .from('files')
      .select('id, original_name, storage_path, extension, size, mime_type, category, previewable, uploaded_at')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) {
      console.error('Supabase fetch error:', fetchError.message);
      res.status(502).json({error: 'Failed to look up file record.'});
      return;
    }

    if (!row) {
      res.status(404).json({error: 'File not found.'});
      return;
    }

    const record = row as DbFileRow;
    const {data: blob, error: downloadError} = await supabase.storage
      .from(BUCKET_NAME)
      .download(record.storage_path);

    if (downloadError || !blob) {
      console.error('Supabase download error:', downloadError?.message);
      res.status(404).json({error: 'File data not found in storage.'});
      return;
    }

    const buffer = Buffer.from(await blob.arrayBuffer());
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', buildContentDisposition(record.original_name, 'attachment'));
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  });

  app.get('/api/files/:id/preview', async (req: Request, res: Response) => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(503).json({error: 'Supabase is not configured.'});
      return;
    }

    const id = String(req.params.id || '');
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({error: 'Invalid file identifier.'});
      return;
    }

    const {data: row, error: fetchError} = await supabase
      .from('files')
      .select('id, original_name, storage_path, extension, size, mime_type, category, previewable, uploaded_at')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) {
      res.status(502).json({error: 'Failed to look up file record.'});
      return;
    }

    const record = row as DbFileRow | null;
    if (!record || !record.previewable) {
      res.status(404).json({error: 'Preview unavailable for this file.'});
      return;
    }

    const {data: blob, error: downloadError} = await supabase.storage
      .from(BUCKET_NAME)
      .download(record.storage_path);

    if (downloadError || !blob) {
      res.status(404).json({error: 'File data not found in storage.'});
      return;
    }

    const lowerMime = record.mime_type.toLowerCase();
    const safeMime = SAFE_IMAGE_PREVIEW_MIMES.has(lowerMime)
      ? lowerMime
      : 'text/plain; charset=utf-8';

    const buffer = Buffer.from(await blob.arrayBuffer());
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'");
    res.setHeader('Content-Type', safeMime);
    res.setHeader('Content-Disposition', buildContentDisposition(record.original_name, 'inline'));
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  });

  app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({error: `API route not found: ${req.method} ${req.originalUrl}`});
  });

  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({error: 'One or more files exceed the 100 MB per-file limit.'});
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        res.status(400).json({error: `You can upload up to ${MAX_FILES_PER_UPLOAD} files at a time.`});
        return;
      }
      res.status(400).json({error: err.message});
      return;
    }
    res.status(500).json({error: 'Unexpected server error.'});
  });

  if (process.env.NODE_ENV !== 'production') {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PocketVault server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
