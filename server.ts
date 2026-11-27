import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express, {type NextFunction, type Request, type Response} from 'express';
import multer from 'multer';

const PORT = 3000;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB per file
const MAX_FILES_PER_UPLOAD = 20;

const STORAGE_DIR = path.resolve(process.cwd(), 'storage');
const UPLOAD_DIR = path.resolve(STORAGE_DIR, 'uploads');
const INDEX_PATH = path.resolve(STORAGE_DIR, 'index.json');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FileCategory = 'documents' | 'images' | 'media' | 'archives' | 'other';

interface InternalFileRecord {
  id: string;
  storedName: string;
  originalName: string;
  extension: string;
  size: number;
  mimeType: string;
  category: FileCategory;
  uploadedAt: string;
  previewable: boolean;
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

function ensureStorageDirs(): void {
  fs.mkdirSync(UPLOAD_DIR, {recursive: true});
  if (!fs.existsSync(INDEX_PATH)) {
    fs.writeFileSync(INDEX_PATH, '[]', 'utf8');
  }
}

ensureStorageDirs();

let indexQueue: Promise<void> = Promise.resolve();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const next = indexQueue.then(task, task);
  indexQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readIndex(): Promise<InternalFileRecord[]> {
  try {
    const raw = await fsp.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as InternalFileRecord[];
  } catch {
    return [];
  }
}

async function writeIndex(records: InternalFileRecord[]): Promise<void> {
  const tempPath = path.resolve(STORAGE_DIR, `index.${crypto.randomUUID()}.tmp`);
  await fsp.writeFile(tempPath, JSON.stringify(records, null, 2), 'utf8');
  await fsp.rename(tempPath, INDEX_PATH);
}

function sanitizeOriginalFilename(rawName: string): string {
  const base = path.basename(rawName || 'untitled').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!base || base === '.' || base === '..') {
    return 'untitled';
  }
  return base.slice(0, 180);
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

function resolveSafeUploadPath(storedName: string): string | null {
  if (!storedName || storedName.includes('/') || storedName.includes('\\')) {
    return null;
  }
  const resolved = path.resolve(UPLOAD_DIR, storedName);
  if (!resolved.startsWith(UPLOAD_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

function toPublicItem(record: InternalFileRecord) {
  return {
    id: record.id,
    originalName: record.originalName,
    extension: record.extension,
    size: record.size,
    mimeType: record.mimeType,
    category: record.category,
    uploadedAt: record.uploadedAt,
    previewable: record.previewable,
  };
}

function buildContentDisposition(filename: string, disposition: 'attachment' | 'inline'): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureStorageDirs();
    cb(null, UPLOAD_DIR);
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

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ok: true});
  });

  app.get('/api/files', async (_req: Request, res: Response) => {
    const records = await runSerialized(() => readIndex());
    const existing: InternalFileRecord[] = [];
    let changed = false;

    for (const record of records) {
      const diskPath = resolveSafeUploadPath(record.storedName);
      if (diskPath && fs.existsSync(diskPath)) {
        existing.push(record);
      } else {
        changed = true;
      }
    }

    if (changed) {
      await runSerialized(() => writeIndex(existing));
    }

    const sorted = [...existing].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    );

    const totalBytes = sorted.reduce((sum, item) => sum + item.size, 0);
    res.json({
      files: sorted.map(toPublicItem),
      totalBytes,
    });
  });

  app.post('/api/files/upload', upload.array('files', MAX_FILES_PER_UPLOAD), async (req: Request, res: Response) => {
    const uploadedFiles = req.files as Express.Multer.File[] | undefined;
    if (!uploadedFiles || uploadedFiles.length === 0) {
      res.status(400).json({error: 'No files were provided in the upload request.'});
      return;
    }

    const now = new Date().toISOString();
    const newRecords: InternalFileRecord[] = uploadedFiles.map((file) => {
      const originalName = sanitizeOriginalFilename(file.originalname);
      const ext = path.extname(originalName).replace(/^\./, '').toUpperCase().slice(0, 12);
      const rawExt = path.extname(originalName);
      const mimeType = file.mimetype || 'application/octet-stream';

      return {
        id: file.filename,
        storedName: file.filename,
        originalName,
        extension: ext || 'FILE',
        size: file.size,
        mimeType,
        category: inferCategory(mimeType, rawExt),
        uploadedAt: now,
        previewable: isPreviewable(mimeType, rawExt),
      };
    });

    await runSerialized(async () => {
      const current = await readIndex();
      await writeIndex([...newRecords, ...current]);
    });

    res.status(201).json({
      files: newRecords.map(toPublicItem),
    });
  });

  app.get('/api/files/:id/download', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({error: 'Invalid file identifier.'});
      return;
    }

    const records = await runSerialized(() => readIndex());
    const record = records.find((item) => item.id === id);
    if (!record) {
      res.status(404).json({error: 'File not found.'});
      return;
    }

    const filePath = resolveSafeUploadPath(record.storedName);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({error: 'File data missing from storage.'});
      return;
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', buildContentDisposition(record.originalName, 'attachment'));
    res.setHeader('Content-Length', String(record.size));

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({error: 'Failed to read file from storage.'});
      }
    });
    stream.pipe(res);
  });

  app.get('/api/files/:id/preview', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({error: 'Invalid file identifier.'});
      return;
    }

    const records = await runSerialized(() => readIndex());
    const record = records.find((item) => item.id === id);
    if (!record || !record.previewable) {
      res.status(404).json({error: 'Preview unavailable for this file.'});
      return;
    }

    const filePath = resolveSafeUploadPath(record.storedName);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({error: 'File data missing from storage.'});
      return;
    }

    const lowerMime = record.mimeType.toLowerCase();
    const safeMime = SAFE_IMAGE_PREVIEW_MIMES.has(lowerMime)
      ? lowerMime
      : 'text/plain; charset=utf-8';

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'");
    res.setHeader('Content-Type', safeMime);
    res.setHeader('Content-Disposition', buildContentDisposition(record.originalName, 'inline'));

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({error: 'Failed to stream preview.'});
      }
    });
    stream.pipe(res);
  });

  app.delete('/api/files/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({error: 'Invalid file identifier.'});
      return;
    }

    const removed = await runSerialized(async () => {
      const current = await readIndex();
      const target = current.find((item) => item.id === id);
      if (!target) {
        return null;
      }
      const next = current.filter((item) => item.id !== id);
      await writeIndex(next);
      return target;
    });

    if (!removed) {
      res.status(404).json({error: 'File not found.'});
      return;
    }

    const filePath = resolveSafeUploadPath(removed.storedName);
    if (filePath) {
      await fsp.unlink(filePath).catch(() => undefined);
    }

    res.json({deletedId: id});
  });

  // Error handler for Multer & API routes
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
