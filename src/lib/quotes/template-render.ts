import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'

// ============================================================
// Filling {{tags}} in an uploaded .docx / .pptx.
//
// The bot's proposal is drawn at fixed pixel coordinates onto a PDF
// built from a Figma export (see render.ts / template.json), which is
// exact but means only a developer can change the design. This path
// trades that precision for a template the business can edit in Word or
// PowerPoint: both formats are OOXML zips, so one library covers them.
// ============================================================

/**
 * Double braces, matching the proposal template the business already
 * writes by hand. Docxtemplater's own default is single `{ }`, which
 * would read `{{nombre}}` as a tag literally named `{nombre`.
 */
const DELIMITERS = { start: '{{', end: '}}' }

/** A template that could not be read or filled, with a reason to show. */
export class TemplateParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateParseError'
  }
}

/**
 * Docxtemplater raises one error carrying many — a template with four
 * malformed tags reports all four. Flatten them into one sentence so
 * the upload dialog can show what to fix, rather than "multi error".
 */
function describe(err: unknown): string {
  if (err && typeof err === 'object' && 'properties' in err) {
    const props = (err as { properties?: { errors?: unknown[] } }).properties
    const inner = props?.errors
    if (Array.isArray(inner) && inner.length > 0) {
      return inner
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join('; ')
    }
  }
  return err instanceof Error ? err.message : String(err)
}

function load(
  bytes: Buffer,
  onMissingTag: (tag: string) => void = () => {},
): Docxtemplater {
  let zip: PizZip
  try {
    zip = new PizZip(bytes)
  } catch {
    throw new TemplateParseError(
      'El archivo no es un .docx o .pptx válido. Guárdalo de nuevo desde Word o PowerPoint e inténtalo otra vez.',
    )
  }

  try {
    return new Docxtemplater(zip, {
      delimiters: DELIMITERS,
      paragraphLoop: true,
      linebreaks: true,
      // A tag the quote can't fill renders blank. The default prints
      // the literal string "undefined", which on a document going to a
      // customer is worse than an empty line.
      nullGetter: (part) => {
        const tag = (part as { value?: unknown } | undefined)?.value
        if (typeof tag === 'string') onMissingTag(tag)
        return ''
      },
    })
  } catch (err) {
    throw new TemplateParseError(
      `No se pudo leer la plantilla: ${describe(err)}`,
    )
  }
}

/**
 * Every {{tag}} the template references. Shown at upload time so the
 * dialog can flag a tag the generator has no value for — a typo'd
 * `{{preico}}` is invisible otherwise until it renders blank on a
 * customer's proposal.
 *
 * Collected by rendering against no data at all, so every tag falls
 * through to `nullGetter`. Docxtemplater ships an InspectModule for
 * this, but it requires lodash, which it does not itself depend on;
 * this reuses the real parser instead of adding a dependency, and so
 * cannot disagree with what `renderQuoteTemplate` sees — including
 * tags Word split across several runs mid-word.
 */
export function inspectTemplateTags(bytes: Buffer): string[] {
  const found = new Set<string>()
  const doc = load(bytes, (tag) => found.add(tag))
  try {
    doc.render({})
  } catch (err) {
    throw new TemplateParseError(
      `No se pudo leer la plantilla: ${describe(err)}`,
    )
  }
  return [...found]
}

/** Fill the template and return the resulting document's bytes. */
export function renderQuoteTemplate(
  bytes: Buffer,
  values: Record<string, string>,
): Buffer {
  const doc = load(bytes)
  try {
    doc.render(values)
  } catch (err) {
    throw new TemplateParseError(
      `No se pudo llenar la plantilla: ${describe(err)}`,
    )
  }
  return doc.toBuffer()
}
