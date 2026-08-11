// Visual proof: render one sample proposal so the field positions can be
// checked against the Figma design.
//
//   npx tsx scripts/proof-quote.ts [outPath]
//
// Uses Osvaldo Coyac's real receipt (2,135 kWh average -> 14 panels,
// 8.75 kW, $127,000; $10,237.30 a bimester) and a long accented name, so
// both the plain fields and the shrink-to-fit path get exercised.
import { writeFile } from 'node:fs/promises'
import { resolveQuote } from '../src/lib/quotes/pricing'
import { buildFinancials, projectionBaseCost } from '../src/lib/quotes/finance'
import { buildQuoteFieldValues, buildFolio } from '../src/lib/quotes/fields'
import { renderQuotePdf } from '../src/lib/quotes/render'

const OUT = process.argv[2] ?? 'proof-quote.pdf'

async function main() {
  const now = new Date()
  const quote = resolveQuote(2_135, 6)
  if (quote.kind !== 'ok') {
    throw new Error(`expected a quotable tier, got ${quote.kind}`)
  }

  const costoBimestralMxn = projectionBaseCost({
    // Fac. del Periodo 9,814.27 + DAP 423.03. NOT the 10,237.85 total.
    costoPeriodoMxn: 10_237.3,
    historialImporteMxn: [6481, 5815, 5589, 7999, 9173],
  })

  const values = buildQuoteFieldValues({
    nombre: 'María Fernanda Villaseñor',
    tier: quote.tier,
    folio: buildFolio(now, 'proof-contact-id'),
    now,
    financials: buildFinancials({ costoBimestralMxn, tier: quote.tier }),
  })
  console.log(values)

  const { bytes, pageCount } = await renderQuotePdf(values)
  await writeFile(OUT, bytes)
  console.log(
    `${OUT}: ${(bytes.length / 1048576).toFixed(2)} MB, ${pageCount} pages`,
  )
}

main()
