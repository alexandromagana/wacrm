import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { DOMParser } from '@xmldom/xmldom';
import type { Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom';
import { PDFDocument, rgb, type PDFImage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  prepareFont,
  measureText,
  drawTextRuns,
  type TextFont,
} from './text-font';

// ============================================================
// PowerPoint → PDF, for the proposal templates the cotizador fills.
//
// Why a converter of our own rather than LibreOffice in the image: the
// proposal templates are all one shape — a full-bleed design PNG per
// slide with absolutely-positioned single-line text on top — which is
// the same model `template.json` already describes for the bot's PDF,
// at the same 816×1056 pt page. So the conversion is a coordinate
// transform plus pdf-lib, using deps already installed, instead of a
// ~1 GB LibreOffice layer that could not be tested before deploying.
//
// The trade-off, stated plainly: this renders absolutely-positioned
// text and pictures. Flowing paragraphs, tables, charts, and Word
// documents are NOT supported — see `convertPptxToPdf`'s throw.
// ============================================================

/** EMU (English Metric Units) per PostScript point. */
const EMU_PER_POINT = 12700;

/**
 * Where the first baseline sits below a text box's top, as a fraction
 * of font size.
 *
 * Calibrated, not guessed: for all six fields the Gama template shares
 * with `template.json`, `(baseline − boxTop) / size` comes out to
 * exactly 0.78 — across both families and five sizes from 10.5 to 46 pt.
 * That constant is the line-box convention the template was authored
 * with (it originates in the Figma export `template.json` was traced
 * from), so using it reproduces the bot's branded PDF exactly.
 *
 * A deck authored by hand in PowerPoint uses the font's own ascent
 * instead (0.878 em for Archivo), which would sit ~1% of the font size
 * lower. Close enough to look right, not close enough to call exact.
 */
const BASELINE_RATIO = 0.78;

/** Text-box insets default to 0.1"/0.05" when the XML omits them. */
const DEFAULT_INSET_EMU = { l: 91440, t: 45720, r: 91440, b: 45720 };

const FONT_FILES = {
  'archivo-regular': 'fonts/Archivo-Regular.ttf',
  'archivo-medium': 'fonts/Archivo-Medium.ttf',
  'archivo-semibold': 'fonts/Archivo-SemiBold.ttf',
  'archivo-bold': 'fonts/Archivo-Bold.ttf',
  'plexmono-regular': 'fonts/IBMPlexMono-Regular.ttf',
} as const;

type FontFileKey = keyof typeof FONT_FILES;

export class PptxConvertError extends Error {}

function assetPath(relative: string): string {
  return join(process.cwd(), 'public', relative);
}

let fontBytesPromise: Promise<Record<FontFileKey, Buffer>> | null = null;

function loadFontBytes(): Promise<Record<FontFileKey, Buffer>> {
  fontBytesPromise ??= (async () => {
    const keys = Object.keys(FONT_FILES) as FontFileKey[];
    const bytes = await Promise.all(
      keys.map((k) => readFile(assetPath(FONT_FILES[k])))
    );
    return Object.fromEntries(keys.map((k, i) => [k, bytes[i]])) as Record<
      FontFileKey,
      Buffer
    >;
  })();
  return fontBytesPromise;
}

/**
 * Pick a TTF for a run's `<a:latin typeface>` plus its bold flag.
 *
 * PowerPoint carries weight two ways: baked into the family name
 * ("Archivo SemiBold") or as the separate `b="1"` toggle. Both are
 * honoured, name first — a deck that names the weight explicitly means
 * it. Anything we don't ship falls back to Archivo rather than failing
 * the whole render over one unknown font.
 */
export function resolveFontKey(typeface: string, bold: boolean): FontFileKey {
  const name = typeface.trim().toLowerCase();
  if (name.includes('plex') || name.includes('mono')) return 'plexmono-regular';
  if (name.includes('bold') || bold) {
    return name.includes('semi') ? 'archivo-semibold' : 'archivo-bold';
  }
  if (name.includes('semi')) return 'archivo-semibold';
  if (name.includes('medium')) return 'archivo-medium';
  return 'archivo-regular';
}

/** "#RRGGBB" / "RRGGBB" → pdf-lib rgb, defaulting to black. */
function parseColor(hex: string | null) {
  const clean = (hex ?? '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return rgb(0, 0, 0);
  return rgb(
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255
  );
}

function parseXml(zip: PizZip, path: string): XmlElement {
  const file = zip.file(path);
  if (!file)
    throw new PptxConvertError(`El archivo .pptx no contiene ${path}.`);
  const doc = new DOMParser().parseFromString(file.asText(), 'text/xml');
  const root = doc.documentElement;
  if (!root) throw new PptxConvertError(`No se pudo leer ${path}.`);
  return root;
}

function isElement(n: XmlNode): n is XmlElement {
  return n.nodeType === 1;
}

function childrenNamed(el: XmlElement, local: string): XmlElement[] {
  return Array.from(el.childNodes).filter(
    (n): n is XmlElement => isElement(n) && n.localName === local
  );
}

function firstNamed(el: XmlElement, local: string): XmlElement | null {
  return (
    Array.from(el.getElementsByTagName('*')).find(
      (n) => n.localName === local
    ) ?? null
  );
}

/** Direct-descendant lookup, so a shape's own xfrm never picks up a child's. */
function firstChildNamed(el: XmlElement, local: string): XmlElement | null {
  return childrenNamed(el, local)[0] ?? null;
}

/** rId → part path, resolved relative to the .rels file's own folder. */
function readRels(zip: PizZip, relsPath: string, baseDir: string) {
  const map = new Map<string, string>();
  if (!zip.file(relsPath)) return map;
  const root = parseXml(zip, relsPath);
  for (const rel of Array.from(root.getElementsByTagName('*'))) {
    if (rel.localName !== 'Relationship') continue;
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target) continue;
    const normalized = target.startsWith('/')
      ? target.slice(1)
      : join(baseDir, target).replace(/\\/g, '/');
    map.set(id, normalized);
  }
  return map;
}

interface Xfrm {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

function readXfrm(spPr: XmlElement | null): Xfrm | null {
  if (!spPr) return null;
  const xfrm = firstNamed(spPr, 'xfrm');
  if (!xfrm) return null;
  const off = firstNamed(xfrm, 'off');
  const ext = firstNamed(xfrm, 'ext');
  if (!off || !ext) return null;
  return {
    x: Number(off.getAttribute('x') ?? 0),
    y: Number(off.getAttribute('y') ?? 0),
    cx: Number(ext.getAttribute('cx') ?? 0),
    cy: Number(ext.getAttribute('cy') ?? 0),
  };
}

interface DrawnRun {
  text: string;
  sizePt: number;
  fontKey: FontFileKey;
  color: ReturnType<typeof rgb>;
}

interface DrawnLine {
  runs: DrawnRun[];
  align: 'l' | 'ctr' | 'r';
}

/**
 * One text box's lines, in order. Each `<a:p>` is a line — we do not
 * wrap, matching both the template's `wrap="none"` boxes and the bot
 * renderer, which treats every field as single-line by design.
 */
function readTextBody(sp: XmlElement): DrawnLine[] {
  const txBody = firstChildNamed(sp, 'txBody');
  if (!txBody) return [];
  const lines: DrawnLine[] = [];
  for (const p of childrenNamed(txBody, 'p')) {
    const pPr = firstChildNamed(p, 'pPr');
    const align = (pPr?.getAttribute('algn') ?? 'l') as DrawnLine['align'];
    const runs: DrawnRun[] = [];
    for (const r of childrenNamed(p, 'r')) {
      const text = childrenNamed(r, 't')
        .map((t) => t.textContent ?? '')
        .join('');
      if (!text) continue;
      const rPr = firstChildNamed(r, 'rPr');
      // sz is in hundredths of a point; 18 pt is PowerPoint's own default.
      const sizePt = rPr?.getAttribute('sz')
        ? Number(rPr.getAttribute('sz')) / 100
        : 18;
      const bold = rPr?.getAttribute('b') === '1';
      const latin = rPr ? firstNamed(rPr, 'latin') : null;
      const typeface = latin?.getAttribute('typeface') ?? 'Archivo';
      const clr = rPr ? firstNamed(rPr, 'srgbClr') : null;
      runs.push({
        text,
        sizePt,
        fontKey: resolveFontKey(typeface, bold),
        color: parseColor(clr?.getAttribute('val') ?? null),
      });
    }
    if (runs.length > 0) lines.push({ runs, align });
  }
  return lines;
}

/**
 * Fill a filled .pptx into a PDF of the same page geometry.
 *
 * Slides are emitted in presentation order (`sldIdLst`), which is NOT
 * the order the slideN.xml files happen to be named — in the Gama
 * template, slide2.xml is the second page shown.
 */
export async function convertPptxToPdf(pptxBytes: Buffer): Promise<Uint8Array> {
  let zip: PizZip;
  try {
    zip = new PizZip(pptxBytes);
  } catch {
    throw new PptxConvertError('El archivo no es un .pptx válido.');
  }
  if (!zip.file('ppt/presentation.xml')) {
    throw new PptxConvertError(
      'Solo se pueden convertir presentaciones de PowerPoint (.pptx) a PDF. ' +
        'Para un documento de Word (.docx), descarga el archivo y expórtalo a PDF desde Word.'
    );
  }

  const presentation = parseXml(zip, 'ppt/presentation.xml');
  const sldSz = firstNamed(presentation, 'sldSz');
  const pageW = Number(sldSz?.getAttribute('cx') ?? 0) / EMU_PER_POINT;
  const pageH = Number(sldSz?.getAttribute('cy') ?? 0) / EMU_PER_POINT;
  if (!(pageW > 0 && pageH > 0)) {
    throw new PptxConvertError(
      'La plantilla no declara un tamaño de diapositiva válido.'
    );
  }

  const presRels = readRels(zip, 'ppt/_rels/presentation.xml.rels', 'ppt');
  const sldIdLst = firstNamed(presentation, 'sldIdLst');
  const slidePaths: string[] = [];
  if (sldIdLst) {
    for (const sldId of childrenNamed(sldIdLst, 'sldId')) {
      const rid =
        sldId.getAttribute('r:id') ?? sldId.getAttribute('relationshipId');
      const target = rid ? presRels.get(rid) : null;
      if (target) slidePaths.push(target);
    }
  }
  if (slidePaths.length === 0) {
    throw new PptxConvertError('La plantilla no tiene diapositivas.');
  }

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle('Propuesta — Gama Energía');
  pdf.setProducer('wacrm');

  const fontBytes = await loadFontBytes();
  // Fonts and images are embedded once per document and reused across
  // pages; embedding per draw would multiply the file size by the number
  // of slides that share the same family or picture.
  const fontCache = new Map<FontFileKey, TextFont>();
  const imageCache = new Map<string, PDFImage>();

  const getFont = async (key: FontFileKey): Promise<TextFont> => {
    let f = fontCache.get(key);
    if (!f) {
      // prepareFont probes the space glyph — see text-font.ts for the
      // IBM Plex Mono defect this steps around.
      f = prepareFont(await pdf.embedFont(fontBytes[key], { subset: true }));
      fontCache.set(key, f);
    }
    return f;
  };

  for (const slidePath of slidePaths) {
    const slide = parseXml(zip, slidePath);
    const dir = slidePath.slice(0, slidePath.lastIndexOf('/'));
    const name = slidePath.slice(slidePath.lastIndexOf('/') + 1);
    const rels = readRels(zip, `${dir}/_rels/${name}.rels`, dir);
    const page = pdf.addPage([pageW, pageH]);

    const spTree = firstNamed(slide, 'spTree');
    if (!spTree) continue;

    // Document order is z-order: the background picture is authored
    // first, so drawing in order layers text over it correctly.
    for (const node of Array.from(spTree.childNodes)) {
      if (!isElement(node)) continue;
      const el = node;

      if (el.localName === 'pic') {
        const box = readXfrm(firstChildNamed(el, 'spPr'));
        const blip = firstNamed(el, 'blip');
        const embed =
          blip?.getAttribute('r:embed') ?? blip?.getAttribute('embed');
        const mediaPath = embed ? rels.get(embed) : null;
        if (!box || !mediaPath) continue;
        let img = imageCache.get(mediaPath);
        if (!img) {
          const file = zip.file(mediaPath);
          if (!file) continue;
          const bytes = file.asUint8Array();
          const lower = mediaPath.toLowerCase();
          try {
            img =
              lower.endsWith('.jpg') || lower.endsWith('.jpeg')
                ? await pdf.embedJpg(bytes)
                : await pdf.embedPng(bytes);
          } catch {
            // An unsupported picture format (gif/tiff/emf) shouldn't cost
            // the whole proposal — skip it and keep the text.
            continue;
          }
          imageCache.set(mediaPath, img);
        }
        const w = box.cx / EMU_PER_POINT;
        const h = box.cy / EMU_PER_POINT;
        page.drawImage(img, {
          x: box.x / EMU_PER_POINT,
          // PPTX measures y down from the top, PDF up from the bottom.
          y: pageH - box.y / EMU_PER_POINT - h,
          width: w,
          height: h,
        });
        continue;
      }

      if (el.localName !== 'sp') continue;
      const box = readXfrm(firstChildNamed(el, 'spPr'));
      const lines = readTextBody(el);
      if (!box || lines.length === 0) continue;

      const txBody = firstChildNamed(el, 'txBody');
      const bodyPr = txBody ? firstChildNamed(txBody, 'bodyPr') : null;
      const insetL =
        Number(bodyPr?.getAttribute('lIns') ?? DEFAULT_INSET_EMU.l) /
        EMU_PER_POINT;
      const insetT =
        Number(bodyPr?.getAttribute('tIns') ?? DEFAULT_INSET_EMU.t) /
        EMU_PER_POINT;
      const insetR =
        Number(bodyPr?.getAttribute('rIns') ?? DEFAULT_INSET_EMU.r) /
        EMU_PER_POINT;

      const boxLeft = box.x / EMU_PER_POINT + insetL;
      const boxRight = (box.x + box.cx) / EMU_PER_POINT - insetR;
      const boxTop = box.y / EMU_PER_POINT + insetT;

      let cursorTop = boxTop;
      for (const line of lines) {
        const lineSize = Math.max(...line.runs.map((r) => r.sizePt));
        const baselineY = pageH - (cursorTop + lineSize * BASELINE_RATIO);

        const widths = await Promise.all(
          line.runs.map(async (r) =>
            measureText(await getFont(r.fontKey), r.text, r.sizePt)
          )
        );
        const lineWidth = widths.reduce((sum, w) => sum + w, 0);

        let x = boxLeft;
        if (line.align === 'r') x = boxRight - lineWidth;
        else if (line.align === 'ctr')
          x = boxLeft + (boxRight - boxLeft - lineWidth) / 2;

        for (let i = 0; i < line.runs.length; i++) {
          const run = line.runs[i];
          drawTextRuns(page, await getFont(run.fontKey), run.text, {
            x,
            y: baselineY,
            size: run.sizePt,
            color: run.color,
          });
          x += widths[i];
        }
        // Single spacing: PowerPoint advances one line box per paragraph.
        cursorTop += lineSize * 1.2;
      }
    }
  }

  return pdf.save();
}
