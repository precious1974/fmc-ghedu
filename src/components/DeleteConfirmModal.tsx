import {useEffect} from 'react';
import type {StoredFileItem} from '../types/files';

interface DeleteConfirmModalProps {
  targets: StoredFileItem[];
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmModal({targets, deleting, onCancel, onConfirm}: DeleteConfirmModalProps) {
  useEffect(() => {
    if (targets.length === 0) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [targets.length, deleting, onCancel]);

  if (targets.length === 0) {
    return null;
  }

  const single = targets.length === 1 ? targets[0] : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      onClick={() => !deleting && onCancel()}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-dialog-title" className="text-base font-semibold text-zinc-900">
          {single ? 'Delete file?' : `Delete ${targets.length} files?`}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">
          {single ? (
            <>
              <span className="font-medium text-zinc-900 break-all">{single.originalName}</span> will be permanently
              removed from storage.
            </>
          ) : (
            `These ${targets.length} selected files will be permanently removed from storage.`
          )}
        </p>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={deleting}
            onClick={onCancel}
            className="min-h-[40px] rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={onConfirm}
            className="min-h-[40px] rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
