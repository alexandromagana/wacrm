// Prep step: turn the raw Figma export into the runtime quote template.
//
//   node scripts/build-quote-template.mjs
//
// Source lives in design/ (Figma exports, tens of MB, never shipped); the
// built template lands in public/quotes/, which the Dockerfile copies whole.
//
// Re-run this whenever the design changes in Figma. Two jobs:
//
//   1. Weight. The cover carries a 4288x2820 lossless photo — ~21 MB of the
//      22.6 MB export, for something displayed 816 px wide. pdf-lib copies the
//      whole template into every generated quote, so that weight is paid per
//      customer, and it blows past the 16 MB cap on the chat-media bucket.
//      We rasterise the cover to a 2x JPEG (~0.5 MB) and leave pages 2-5
//      vector. The cover's own text becomes raster at 192 dpi; the variable
//      text drawn at render time stays vector.
//
//   2. Shape. Pages 1-4 are portrait 816x1056; page 5 — the financing annex —
//      is landscape 1056x816. Mixed orientation in one PDF is ordinary, but it
//      means the size check has to be per page, and `src/lib/quotes/
//      template.json` carries a `pages` array rather than one global size.
//
// Pages keep their native 816x1056. That is US Letter at 96 dpi, so the PDF is
// physically 28.8 x 37.3 cm rather than 21.6 x 27.9 — cosmetic only, since
// viewers fit to screen and print dialogs default to fit-to-page. Scaling to
// real Letter was tried and abandoned: BOTH pdf-lib routes mangle these
// exports. page.scale() dropped the logo group and clipped everything past
// x=612; embedPage()+drawPage() erased the rounded-corner cards almost
// entirely. Text survived both, the clipped shape groups did not, and neither
// raised an error. If real Letter is ever wanted, resize the frames in Figma.
//
// macOS-only: uses qlmanage + sips for the rasterisation. This is a dev-time
// step run on a Mac, never in the container.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { PDFDocument } from 'pdf-lib'

// AFTER RUNNING THIS, LOOK AT PAGES 2 AND 5. Every variable field in the design
// must sit at opacity 0 in Figma so the renderer can draw over it, and a
// placeholder left visible collides with the value on every proposal.
// That check has to be a human looking at a render: these exports carry
// the hidden layers' text in the content stream anyway (for copy-paste),
// so a hidden placeholder and a visible one are indistinguishable to any
// text extraction. Tried it; it reports both.
//
//   node -e 'import("pdf-lib").then(async({PDFDocument})=>{const fs=await import("node:fs/promises");
//     const s=await PDFDocument.load(await fs.readFile("public/quotes/template.pdf"));
//     const o=await PDFDocument.create();o.addPage((await o.copyPages(s,[1]))[0]);
//     await fs.writeFile("/tmp/p2.pdf",await o.save())})'
//   qlmanage -t -s 1600 -o /tmp /tmp/p2.pdf && open /tmp/p2.pdf.png
const SRC = process.argv[2] ?? 'design/Bot _Template_Update.pdf'
const OUT = process.argv[3] ?? 'public/quotes/template.pdf'

// Must stay in step with `pages` in src/lib/quotes/template.json — the
// renderer refuses to draw on a template whose pages are not these sizes.
const EXPECTED_PAGES = [
  { width: 816, height: 1056 },
  { width: 816, height: 1056 },
  { width: 816, height: 1056 },
  { width: 816, height: 1056 },
  { width: 1056, height: 816 }, // anexo de financiamiento, horizontal
]
const COVER_W = EXPECTED_PAGES[0].width
const COVER_H = EXPECTED_PAGES[0].height
const COVER_QUALITY = 85

const src = await PDFDocument.load(await readFile(SRC))
const pages = src.getPages()
if (pages.length !== EXPECTED_PAGES.length) {
  throw new Error(
    `expected ${EXPECTED_PAGES.length} pages in ${SRC}, got ${pages.length}`,
  )
}
for (const [i, p] of pages.entries()) {
  const { width, height } = p.getSize()
  const want = EXPECTED_PAGES[i]
  if (Math.round(width) !== want.width || Math.round(height) !== want.height) {
    throw new Error(
      `page ${i + 1} is ${width}x${height}, expected ${want.width}x${want.height}. ` +
        'Re-export the frames from Figma at their original size.',
    )
  }
  if (p.getRotation().angle !== 0) {
    throw new Error(
      `page ${i + 1} is rotated. The annex must be a landscape FRAME, not a ` +
        'portrait one turned on its side — the renderer refuses rotated pages.',
    )
  }
}

// qlmanage renders page 1 only, which is exactly the page we want to flatten.
// -s is the max dimension, so 2112 yields 1632x2112 = 2x the real page.
const tmp = mkdtempSync(join(tmpdir(), 'quote-template-'))
try {
  execFileSync('qlmanage', ['-t', '-s', String(COVER_H * 2), '-o', tmp, SRC], {
    stdio: 'ignore',
  })
  const coverPng = join(tmp, `${basename(SRC)}.png`)
  const coverJpg = join(tmp, 'cover.jpg')
  execFileSync('sips', [
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(COVER_QUALITY),
    coverPng, '--out', coverJpg,
  ], { stdio: 'ignore' })

  const out = await PDFDocument.create()

  const jpg = await out.embedJpg(await readFile(coverJpg))
  const cover = out.addPage([COVER_W, COVER_H])
  cover.drawImage(jpg, { x: 0, y: 0, width: COVER_W, height: COVER_H })

  // Content pages copied verbatim — untouched vector, no transform.
  // copyPages preserves each page's own MediaBox, so the landscape
  // annex arrives landscape without a transform of our own.
  const rest = pages.map((_, i) => i).slice(1)
  for (const p of await out.copyPages(src, rest)) out.addPage(p)

  out.setTitle('Propuesta — Gama Energía')
  out.setProducer('wacrm')

  const bytes = await out.save({ useObjectStreams: true })
  await writeFile(OUT, bytes)

  const before = (await readFile(SRC)).length
  console.log(
    `${OUT}: ${(bytes.length / 1048576).toFixed(2)} MB ` +
      `(from ${(before / 1048576).toFixed(2)} MB), ${out.getPageCount()} pages`,
  )
  for (const [i, p] of out.getPages().entries()) {
    const { width, height } = p.getSize()
    console.log(`  page ${i + 1}: ${width} x ${height}`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
