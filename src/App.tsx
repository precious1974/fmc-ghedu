import {useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent} from 'react';
import {
  Archive,
  Check,
  Download,
  Eye,
  File as FileIcon,
  FileText,
  Film,
  Image as ImageIcon,
  Search,
  Upload,
  X,
} from 'lucide-react';
import {FilePreviewModal} from './components/FilePreviewModal';
import type {FileCategory, FileListResponse, StoredFileItem} from './types/files';
import {formatBytes, formatDate} from './utils/format';

type SortOption = 'newest' | 'name' | 'size';

interface UploadProgressState {
  fileCount: number;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
}

const CATEGORIES: Array<{id: FileCategory; label: string}> = [
  {id: 'all', label: 'All Files'},
  {id: 'documents', label: 'Documents'},
  {id: 'images', label: 'Images'},
  {id: 'media', label: 'Media'},
  {id: 'archives', label: 'Archives'},
];

function renderFileIcon(category: StoredFileItem['category']) {
  const iconClass = 'h-4 w-4 shrink-0 text-zinc-500';
  switch (category) {
    case 'images':
      return <ImageIcon className={iconClass} aria-hidden="true" />;
    case 'documents':
      return <FileText className={iconClass} aria-hidden="true" />;
    case 'media':
      return <Film className={iconClass} aria-hidden="true" />;
    case 'archives':
      return <Archive className={iconClass} aria-hidden="true" />;
    default:
      return <FileIcon className={iconClass} aria-hidden="true" />;
  }
}

export default function App() {
  const [files, setFiles] = useState<StoredFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  const [category, setCategory] = useState<FileCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('newest');

  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewTarget, setPreviewTarget] = useState<StoredFileItem | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  const fetchFiles = useCallback(async () => {
    try {
      const response = await fetch('/api/files');
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {error?: string} | null;
        throw new Error(body?.error || 'Could not load stored files.');
      }
      const data: FileListResponse = await response.json();
      setFiles(data.files);
      setSelectedIds((prev) => {
        const validIds = new Set(data.files.map((f) => f.id));
        const next = new Set<string>();
        prev.forEach((id) => {
          if (validIds.has(id)) {
            next.add(id);
          }
        });
        return next;
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not load stored files.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  const uploadFiles = useCallback(
    (incoming: FileList | File[]) => {
      const fileArray = Array.from(incoming);
      if (fileArray.length === 0 || uploadProgress !== null) {
        return;
      }

      setErrorMessage(null);
      setNoticeMessage(null);

      const formData = new FormData();
      let estimatedTotal = 0;
      for (const file of fileArray) {
        formData.append('files', file);
        estimatedTotal += file.size;
      }

      setUploadProgress({
        fileCount: fileArray.length,
        loadedBytes: 0,
        totalBytes: estimatedTotal,
        percent: 0,
      });

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload');

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
          setUploadProgress({
            fileCount: fileArray.length,
            loadedBytes: event.loaded,
            totalBytes: event.total,
            percent,
          });
        }
      };

      xhr.onload = () => {
        setUploadProgress(null);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const payload = JSON.parse(xhr.responseText) as {files?: StoredFileItem[]};
            const uploaded = payload.files ?? [];
            if (uploaded.length > 0) {
              setFiles((prev) => [...uploaded, ...prev]);
              setNoticeMessage(
                uploaded.length === 1
                  ? `Stored "${uploaded[0].originalName}" permanently.`
                  : `Stored ${uploaded.length} files permanently.`,
              );
            } else {
              void fetchFiles();
            }
          } catch {
            void fetchFiles();
          }
        } else {
          try {
            const errBody = JSON.parse(xhr.responseText) as {error?: string};
            setErrorMessage(errBody.error || 'Upload failed.');
          } catch {
            setErrorMessage('Upload failed. Please check file size and try again.');
          }
        }
      };

      xhr.onerror = () => {
        setUploadProgress(null);
        setErrorMessage('Network error while uploading. Please try again.');
      };

      xhr.send(formData);
    },
    [fetchFiles, uploadProgress],
  );

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      uploadFiles(event.target.files);
    }
    event.target.value = '';
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      uploadFiles(event.dataTransfer.files);
    }
  };

  const triggerDownload = useCallback((file: StoredFileItem) => {
    const link = document.createElement('a');
    link.href = `/api/files/${encodeURIComponent(file.id)}/download`;
    link.download = file.originalName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  const filteredFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const list = files.filter((file) => {
      if (category !== 'all' && file.category !== category) {
        return false;
      }
      if (query && !file.originalName.toLowerCase().includes(query) && !file.extension.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });

    list.sort((a, b) => {
      if (sortBy === 'name') {
        return a.originalName.localeCompare(b.originalName);
      }
      if (sortBy === 'size') {
        return b.size - a.size;
      }
      return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
    });

    return list;
  }, [files, category, searchQuery, sortBy]);

  const totalFilteredBytes = useMemo(
    () => filteredFiles.reduce((sum, item) => sum + item.size, 0),
    [filteredFiles],
  );

  const allVisibleSelected =
    filteredFiles.length > 0 && filteredFiles.every((item) => selectedIds.has(item.id));

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        filteredFiles.forEach((item) => next.delete(item.id));
      } else {
        filteredFiles.forEach((item) => next.add(item.id));
      }
      return next;
    });
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedFiles = useMemo(
    () => files.filter((item) => selectedIds.has(item.id)),
    [files, selectedIds],
  );

  const handleDownloadSelected = () => {
    selectedFiles.forEach((file, index) => {
      window.setTimeout(() => {
        triggerDownload(file);
      }, index * 200);
    });
  };

  const openFilePicker = () => {
    if (uploadProgress === null) {
      fileInputRef.current?.click();
    }
  };

  const hasActiveFilters = category !== 'all' || searchQuery.trim().length > 0;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileInputChange}
        className="sr-only"
        aria-label="Choose files to upload"
      />

      {/* Top Bar: 3 zones separated by gap-8 */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-8 px-4 py-3.5 sm:px-6">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              setCategory('all');
              setSearchQuery('');
            }}
            className="text-lg font-bold tracking-tight text-zinc-900 whitespace-nowrap shrink-0"
          >
            PocketVault
          </a>

          <nav aria-label="File categories" className="hidden md:flex items-center gap-6">
            {CATEGORIES.map((item) => {
              const active = category === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setCategory(item.id)}
                  className={`border-b-2 py-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600 ${
                    active
                      ? 'border-blue-600 text-zinc-900'
                      : 'border-transparent text-zinc-500 hover:text-zinc-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={openFilePicker}
            disabled={uploadProgress !== null}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload Files
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {/* Upload Dropzone */}
        <section aria-label="Upload files">
          <div
            role="button"
            tabIndex={0}
            onClick={openFilePicker}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openFilePicker();
              }
            }}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`group flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-9 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
              isDragging
                ? 'border-blue-600 bg-blue-50/70'
                : 'border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50/50'
            }`}
          >
            {uploadProgress ? (
              <div className="w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-zinc-900">
                    Uploading {uploadProgress.fileCount}{' '}
                    {uploadProgress.fileCount === 1 ? 'file' : 'files'}...
                  </span>
                  <span className="font-mono text-xs font-medium text-blue-600 tabular-nums">
                    {uploadProgress.percent}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                  <div
                    className="h-full bg-blue-600 transition-all duration-150"
                    style={{width: `${uploadProgress.percent}%`}}
                  />
                </div>
                <p className="font-mono text-xs text-zinc-500 tabular-nums">
                  {formatBytes(uploadProgress.loadedBytes)} / {formatBytes(uploadProgress.totalBytes)}
                </p>
              </div>
            ) : (
              <>
                <div
                  className={`mb-3 flex h-11 w-11 items-center justify-center rounded-lg border transition-colors ${
                    isDragging
                      ? 'border-blue-200 bg-blue-100 text-blue-600'
                      : 'border-zinc-200 bg-zinc-50 text-zinc-600 group-hover:border-zinc-300 group-hover:text-zinc-900'
                  }`}
                >
                  <Upload className="h-5 w-5" aria-hidden="true" />
                </div>
                <h1 className="text-base font-semibold text-zinc-900">
                  {isDragging ? 'Drop files to upload' : 'Drop files here or click to browse'}
                </h1>
                <p className="mt-1 text-sm text-zinc-500">
                  Uploaded files are stored permanently for preview and download anytime.
                </p>
              </>
            )}
          </div>
        </section>

        {/* Feedback banners */}
        {errorMessage && (
          <div
            role="alert"
            className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            <span>{errorMessage}</span>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              aria-label="Dismiss error"
              className="rounded p-1 text-red-700 hover:bg-red-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {noticeMessage && !errorMessage && (
          <div
            role="status"
            className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          >
            <span className="flex items-center gap-2">
              <Check className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
              {noticeMessage}
            </span>
            <button
              type="button"
              onClick={() => setNoticeMessage(null)}
              aria-label="Dismiss notice"
              className="rounded p-1 text-emerald-700 hover:bg-emerald-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Mobile category selector */}
        <div className="mt-6 flex items-center gap-4 overflow-x-auto border-b border-zinc-200 pb-2 md:hidden">
          {CATEGORIES.map((item) => {
            const active = category === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setCategory(item.id)}
                className={`border-b-2 pb-1.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active ? 'border-blue-600 text-zinc-900' : 'border-transparent text-zinc-500'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* File List Controls */}
        <section aria-label="Uploaded files" className="mt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files..."
                aria-label="Search files"
                className="min-h-[40px] w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-9 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-600 focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-700"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 sm:justify-end">
              {selectedFiles.length > 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-600 tabular-nums">
                    {selectedFiles.length} selected
                  </span>
                  <button
                    type="button"
                    onClick={handleDownloadSelected}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 transition-colors hover:bg-zinc-50 whitespace-nowrap shrink-0"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Download Selected
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="inline-flex min-h-[36px] items-center rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900 whitespace-nowrap shrink-0"
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <p className="text-xs text-zinc-500 tabular-nums">
                  {filteredFiles.length} {filteredFiles.length === 1 ? 'file' : 'files'}
                  <span className="mx-1.5" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-mono">{formatBytes(totalFilteredBytes)}</span>
                </p>
              )}

              <select
                aria-label="Sort files"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="min-h-[40px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 focus:border-blue-600 focus:outline-none"
              >
                <option value="newest">Newest first</option>
                <option value="name">Name A–Z</option>
                <option value="size">Largest first</option>
              </select>
            </div>
          </div>

          {/* File Table */}
          <div className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            {loading ? (
              <div className="divide-y divide-zinc-200">
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className="flex items-center justify-between gap-4 px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="h-4 w-4 animate-pulse rounded bg-zinc-200" />
                      <div className="h-4 w-48 animate-pulse rounded bg-zinc-200" />
                    </div>
                    <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
                  </div>
                ))}
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
                <FileIcon className="mb-3 h-8 w-8 text-zinc-300" aria-hidden="true" />
                <p className="text-sm font-medium text-zinc-900">
                  {hasActiveFilters ? 'No matching files' : 'No files uploaded yet'}
                </p>
                <p className="mt-1 text-sm text-zinc-500">
                  {hasActiveFilters
                    ? 'Try clearing your search query or switching to All Files.'
                    : 'Upload your first file above to store it permanently for download.'}
                </p>
                {hasActiveFilters ? (
                  <button
                    type="button"
                    onClick={() => {
                      setCategory('all');
                      setSearchQuery('');
                    }}
                    className="mt-4 min-h-[40px] rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 whitespace-nowrap shrink-0"
                  >
                    Clear filters
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={openFilePicker}
                    className="mt-4 min-h-[40px] rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
                  >
                    Choose files
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-200 bg-zinc-50/70 text-xs font-medium text-zinc-500">
                      <th className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          aria-label="Select all visible files"
                          className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-600"
                        />
                      </th>
                      <th className="px-2 py-3 font-medium">Name</th>
                      <th className="hidden px-4 py-3 font-medium sm:table-cell">Type</th>
                      <th className="px-4 py-3 text-right font-medium">Size</th>
                      <th className="hidden px-4 py-3 text-right font-medium md:table-cell">Uploaded</th>
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 text-sm">
                    {filteredFiles.map((file) => {
                      const isSelected = selectedIds.has(file.id);
                      return (
                        <tr
                          key={file.id}
                          className={`transition-colors hover:bg-zinc-50 ${
                            isSelected ? 'bg-blue-50/40' : ''
                          }`}
                        >
                          <td className="px-4 py-2.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectOne(file.id)}
                              aria-label={`Select ${file.originalName}`}
                              className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-600"
                            />
                          </td>
                          <td className="max-w-[220px] px-2 py-2.5 sm:max-w-sm">
                            <div className="flex items-center gap-2.5">
                              {renderFileIcon(file.category)}
                              {file.previewable ? (
                                <button
                                  type="button"
                                  onClick={() => setPreviewTarget(file)}
                                  title={file.originalName}
                                  className="truncate text-left font-medium text-zinc-900 hover:text-blue-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                                >
                                  {file.originalName}
                                </button>
                              ) : (
                                <span
                                  title={file.originalName}
                                  className="truncate font-medium text-zinc-900"
                                >
                                  {file.originalName}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="hidden px-4 py-2.5 font-mono text-xs text-zinc-500 sm:table-cell">
                            {file.extension}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-zinc-600 tabular-nums whitespace-nowrap">
                            {formatBytes(file.size)}
                          </td>
                          <td className="hidden px-4 py-2.5 text-right text-xs text-zinc-500 tabular-nums whitespace-nowrap md:table-cell">
                            {formatDate(file.uploadedAt)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {file.previewable && (
                                <button
                                  type="button"
                                  onClick={() => setPreviewTarget(file)}
                                  aria-label={`Preview ${file.originalName}`}
                                  title="Preview"
                                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                                >
                                  <Eye className="h-4 w-4" aria-hidden="true" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => triggerDownload(file)}
                                aria-label={`Download ${file.originalName}`}
                                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 whitespace-nowrap shrink-0"
                              >
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                <span className="hidden sm:inline">Download</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </main>

      <FilePreviewModal
        file={previewTarget}
        onClose={() => setPreviewTarget(null)}
        onDownload={triggerDownload}
      />
    </div>
  );
}
