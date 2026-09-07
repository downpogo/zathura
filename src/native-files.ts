import { invoke } from '@tauri-apps/api/core';

declare const nativeFileHandle: unique symbol;
/** An in-memory capability, never a path or a value to persist. */
export type NativeFileHandle = string & { readonly [nativeFileHandle]: true };

export type NativeFileErrorCode =
  | 'unauthorized' | 'busy' | 'invalid_handle' | 'missing' | 'unreadable'
  | 'empty' | 'not_pdf' | 'too_large' | 'limit_reached' | 'internal';

export interface SelectedNativeFile {
  handle: NativeFileHandle;
  /** Untrusted basename only. Render with textContent, never innerHTML. */
  name: string;
  size: number;
  /** Focus the existing session; this is not a second ownership reference. */
  alreadyOpen: boolean;
}

export interface NativeFileSelection {
  cancelled: boolean;
  files: SelectedNativeFile[];
  errors: { selectionIndex: number; error: NativeFileErrorCode }[];
}

const messages: Record<NativeFileErrorCode, string> = {
  unauthorized: 'File access is not authorized from this window.',
  busy: 'Another file operation is in progress. Try again when it finishes.',
  invalid_handle: 'This document is closed or its file handle is invalid.',
  missing: 'The selected file no longer exists.',
  unreadable: 'The selected file cannot be read.',
  empty: 'The selected file is empty.',
  not_pdf: 'The selected file does not start with a PDF header.',
  too_large: 'The selected file exceeds the 128 MiB whole-file limit.',
  limit_reached: 'Open at most 32 files at once and 64 documents in total.',
  internal: 'The native file operation could not be completed.',
};

export class NativeFileError extends Error {
  readonly code: NativeFileErrorCode;

  constructor(code: NativeFileErrorCode) {
    super(messages[code]);
    this.name = 'NativeFileError';
    this.code = code;
  }
}

async function call<T>(command: string, args?: { handle: NativeFileHandle }): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    // Do not surface raw bridge errors: they can contain implementation details.
    const code = typeof error === 'string' && Object.hasOwn(messages, error)
      ? error as NativeFileErrorCode : 'internal';
    throw new NativeFileError(code);
  }
}

/** Cancel resolves normally with empty files/errors; keep current sessions. */
export function selectPdfFiles(): Promise<NativeFileSelection> {
  return call('select_pdf_files');
}

/** Serialize reads. A concurrent native read rejects with `busy`, not a queue. */
export async function readPdfFile(handle: NativeFileHandle): Promise<Uint8Array> {
  const buffer = await call<ArrayBuffer>('read_pdf_file', { handle });
  if (!(buffer instanceof ArrayBuffer)) throw new NativeFileError('internal');
  return new Uint8Array(buffer);
}

/** Release exactly once per session, including failed loads and abandoned selections. */
export function releasePdfFile(handle: NativeFileHandle): Promise<void> {
  return call('release_pdf_file', { handle });
}
