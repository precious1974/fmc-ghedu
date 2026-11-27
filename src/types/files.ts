export type FileCategory = 'all' | 'documents' | 'images' | 'media' | 'archives' | 'other';

export interface StoredFileItem {
  id: string;
  originalName: string;
  extension: string;
  size: number;
  mimeType: string;
  category: Exclude<FileCategory, 'all'>;
  uploadedAt: string;
  previewable: boolean;
}

export interface FileListResponse {
  files: StoredFileItem[];
  totalBytes: number;
}
