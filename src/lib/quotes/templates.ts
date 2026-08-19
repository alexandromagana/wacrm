import type { QuoteTemplateFileType } from '@/types';

// ============================================================
// Facts about quote template files, shared by the upload route, the
// generator, and the browser UI. No server-only imports — the upload
// dialog reads the size limit and the accept list from here too.
// ============================================================

export const QUOTE_ASSETS_BUCKET = 'quote-assets';

/** Matches the bucket's own file_size_limit in migration 041. */
export const TEMPLATE_MAX_BYTES = 25 * 1024 * 1024;

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** For the file picker's `accept` attribute. */
export const TEMPLATE_ACCEPT = `.docx,.pptx,${DOCX_MIME},${PPTX_MIME}`;

/**
 * The template's kind, or null if it is neither.
 *
 * Falls back to the extension because browsers and operating systems
 * mislabel OOXML often enough to matter — an upload from a phone or a
 * file that has been through a cloud drive can arrive as
 * `application/octet-stream` or with an empty type. The file is parsed
 * immediately after this check, so a wrong guess fails there with a
 * clear message rather than being stored.
 */
export function templateFileType(
  mimeType: string,
  fileName: string
): QuoteTemplateFileType | null {
  const name = fileName.toLowerCase();
  if (mimeType === DOCX_MIME || name.endsWith('.docx')) return 'docx';
  if (mimeType === PPTX_MIME || name.endsWith('.pptx')) return 'pptx';
  return null;
}

/**
 * MIME for a stored file. Accepts 'pdf' as well as the two template
 * types, because a .pptx template is delivered to the customer as PDF
 * (see convertPptxToPdf) while the uploaded template itself stays OOXML.
 */
export function templateMimeType(
  fileType: QuoteTemplateFileType | 'pdf'
): string {
  if (fileType === 'pdf') return 'application/pdf';
  return fileType === 'docx' ? DOCX_MIME : PPTX_MIME;
}
