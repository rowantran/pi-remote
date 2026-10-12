export interface PathCompletionItem { value: string; label: string; directory: boolean }
export interface PathCompletionResult { items: PathCompletionItem[]; truncated: boolean }
export interface CompletePathOptions { prefix: string; cwd?: string; directoriesOnly?: boolean }
export interface AttachmentImage { type: 'image'; data: string; mimeType: string }
export interface Attachment { path: string; text?: string; image?: AttachmentImage }
export interface FilesystemMetadata { homeDir: string; gitBranch?: string }
export const MAX_COMPLETION_ITEMS = 500;
export const MAX_DIRECTORY_ENTRIES = 10_000;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
