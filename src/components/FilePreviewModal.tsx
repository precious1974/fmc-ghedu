import {useEffect, useState} from 'react';
import {Download, X} from 'lucide-react';
import type {StoredFileItem} from '../types/files';
import {formatBytes, formatDate} from '../utils/format';

interface FilePreviewModalProps {
  file: StoredFileItem | null;
  onClose: () => void;
  onDownload: (file: StoredFileItem) => void;
}

export function FilePreviewModal({file, onClose, onDownload}: FilePreviewModalProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const isImage = file ? file.mimeType.toLowerCase().startsWith('image/') : false;

  useEffect(() => {
    if (!file) {
      setTextContent(null);
      setPreviewError(null);
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    if (!isImage) {
      let cancelled = false;
      setLoadingText(true);
      setPreviewError(null);
      setTextContent(null);

      fetch(`/api/files/${encodeURIComponent(file.id)}/preview`)
        .then(async (res) => {
          if (!res.ok) {
            throw new Error('Unable to load preview.');
          }
          return res.text();
        })
        .then((text) => {
          if (!cancelled) {
            setTextContent(text.slice(0, 120_000));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setPreviewError('Could not load text preview for this file.');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoadingText(false);
          }
        });

      return () => {
        cancelled = true;
        window.removeEventListener('keydown', handleKeyDown);
      };
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [file, isImage, onClose]);

  if (!file) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-dialog-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-zinc-200 px-6 py-4">
          <div className="min-w-0">
            <h2 id="preview-dialog-title" className="truncate text-base font-semibold text-zinc-900">
              {file.originalName}
            </h2>
            <p className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
              <span className="font-mono">{file.extension}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{formatBytes(file.size)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{formatDate(file.uploadedAt)}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onDownload(file)}
              className="inline-flex min-h-[38px] items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-zinc-200 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-zinc-50 p-6">
          {isImage ? (
            <div className="flex min-h-[260px] items-center justify-center">
              <img
                src={`/api/files/${encodeURIComponent(file.id)}/preview`}
                alt={file.originalName}
                className="max-h-[64vh] w-auto rounded-lg border border-zinc-200 bg-white object-contain"
              />
            </div>
          ) : loadingText ? (
            <div className="space-y-2 py-4">
              <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200" />
              <div className="h-4 w-full animate-pulse rounded bg-zinc-200" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-zinc-200" />
            </div>
          ) : previewError ? (
            <p className="text-sm text-red-600">{previewError}</p>
          ) : (
            <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-white p-4 font-mono text-xs leading-relaxed text-zinc-800 whitespace-pre-wrap break-words">
              {textContent || '(Empty file)'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
