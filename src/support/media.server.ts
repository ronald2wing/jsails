import mime from 'mime-types';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export type MediaErrorCode = 'invalid_argument' | 'detect_failed';

export class MediaError extends SupportError {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaType {
  /** Sniffed MIME type, e.g. `image/png`. */
  readonly mime: string;
  /** Canonical file extension without a leading dot, e.g. `png`. */
  readonly extension: string;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
  /** Detected image type, e.g. `png`, when the parser can determine it. */
  readonly type?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a path or bare extension to its MIME type.
 *
 * Returns `false` when the type cannot be determined (mirrors `mime-types`).
 */
export function mimeOf(pathOrExt: string): string | false {
  return mime.lookup(pathOrExt);
}

/**
 * Map a MIME type to its canonical extension (without a leading dot).
 *
 * Returns `false` when the type is unknown (mirrors `mime-types`).
 */
export function extension(mimeType: string): string | false {
  return mime.extension(mimeType);
}

/**
 * Sniff a buffer's media type from its magic bytes.
 *
 * Returns `undefined` when the format is unrecognized — a "no match" is a
 * value, not an error.
 */
export async function detect(buffer: Uint8Array): Promise<MediaType | undefined> {
  if (!(buffer instanceof Uint8Array)) {
    throw new MediaError('invalid_argument', 'detect: expected a Uint8Array');
  }
  try {
    const result = await fileTypeFromBuffer(buffer);
    if (!result) return undefined;
    return { mime: result.mime, extension: result.ext };
  } catch (error) {
    throw new MediaError('detect_failed', 'detect: could not read the buffer', { cause: error });
  }
}

/**
 * Read image dimensions from a buffer.
 *
 * Returns `undefined` when the buffer is not a recognizable image — a "no
 * match" is a value, not an error.
 */
export function imageSizeOf(buffer: Uint8Array): ImageSize | undefined {
  if (!(buffer instanceof Uint8Array)) {
    throw new MediaError('invalid_argument', 'imageSize: expected a Uint8Array');
  }
  try {
    const result = imageSize(buffer);
    if (result.width === undefined || result.height === undefined) return undefined;
    return { width: result.width, height: result.height, type: result.type };
  } catch {
    // A malformed/unsupported image is a "no result", not a failure.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Media = Object.freeze({
  mime: mimeOf,
  extension,
  detect,
  imageSize: imageSizeOf,
});
