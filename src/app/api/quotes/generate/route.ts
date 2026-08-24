import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import {
  buildExtraction,
  extractReceiptFromFiles,
  inferPropertyType,
  saveReceiptData,
  type MediaFile,
  type ReceiptExtraction,
} from '@/lib/ai/receipt';
import { combineReadings, sameMeter } from '@/lib/ai/meters';
import {
  resolveQuote,
  type ReviewReason,
  type SolarTier,
} from '@/lib/quotes/pricing';
import {
  emptyManualReading,
  hasConsumption,
  parseManualReadings,
  type ManualMeterReading,
} from '@/lib/quotes/reading';
import { buildFinancials, projectionBaseCost } from '@/lib/quotes/finance';
import { buildFolio } from '@/lib/quotes/fields';
import { buildQuoteMergeFields } from '@/lib/quotes/merge-fields';
import {
  renderQuoteTemplate,
  TemplateParseError,
} from '@/lib/quotes/template-render';
import {
  PROJECT_TYPE_SELECT,
  toFinanceConstants,
  toSolarTiers,
} from '@/lib/quotes/project-types';
import { QUOTE_ASSETS_BUCKET, templateMimeType } from '@/lib/quotes/templates';
import { convertPptxToPdf, PptxConvertError } from '@/lib/quotes/pptx-to-pdf';
import {
  appendFinancingAnnex,
  extractFinancingAnnexPage,
} from '@/lib/quotes/financing-annex';
import { uploadServerMedia } from '@/lib/storage/upload-server';
import type {
  QuoteProjectType,
  QuoteRateTier,
  QuoteTemplate,
  QuoteTemplateFileType,
} from '@/types';

/** Long enough for a full legal name, short enough to fit the layout. */
const CLIENT_NAME_MAX = 120;

/** A CFE bill is commonly two pages, photographed separately. */
const MAX_RECEIPT_FILES = 3;
const RECEIPT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Meters one quote may cover. Matches the bot's own ceiling in
 * `@/lib/ai/meters`; past it the project is commercial enough to
 * deserve a design rather than a table lookup.
 */
const MAX_METERS = 4;

/**
 * Pull the uploaded bills out of the form, grouped by meter.
 *
 * The grouping is stated by the person filling the form — `receipt_files_0`
 * is the first meter, `receipt_files_1` the second — rather than guessed
 * from the files. The bot has to infer it (see `groupIntoReceipts`),
 * because a customer on WhatsApp just sends what they have; here someone
 * who can see the bills is doing the uploading, so asking them is both
 * cheaper and exact. It is also the only way to get photographed bills
 * right: nothing in two JPEGs says whether they are two pages of one
 * meter or one page each of two.
 *
 * Falls back to the flat `receipt_files` field as a single meter, which
 * is what the form posted before meters existed.
 */
export function readMeterGroups(form: FormData): File[][] {
  const groups: File[][] = [];
  for (let i = 0; i < MAX_METERS; i++) {
    const files = form
      .getAll(`receipt_files_${i}`)
      .filter((f): f is File => f instanceof File)
      .slice(0, MAX_RECEIPT_FILES);
    // Indices can arrive with holes when a middle group was removed in
    // the UI, so gaps are skipped rather than ending the scan.
    if (files.length > 0) groups.push(files);
  }
  if (groups.length > 0) return groups;

  const flat = form
    .getAll('receipt_files')
    .filter((f): f is File => f instanceof File)
    .slice(0, MAX_RECEIPT_FILES);
  return flat.length > 0 ? [flat] : [];
}

/**
 * Why a reading can be priced in chat but must not become a document.
 * The bot skips these silently and asks the customer a question; here a
 * person is waiting, so each one is said out loud.
 *
 * `needs_review` names WHICH of its two causes fired. The single
 * sentence that used to cover both ("falta el bimestre actual, o el
 * historial trae un periodo muy por debajo") left the user unable to
 * tell an OCR miss from a judgement call about the customer's house —
 * and every message here ends at a review card showing the numbers, so
 * it has to say which one to go look at.
 */
function explainRefusal(
  kind: string,
  kwh?: number,
  reason?: ReviewReason,
  outlierKwh?: number
): string {
  switch (kind) {
    case 'unreadable':
      return 'No se pudo leer el consumo del recibo. Sube una foto más nítida, o captura los datos a mano abajo.';
    case 'implausible':
      return `El consumo (${kwh} kWh bimestrales) no parece el de un recibo real. Revisa que sea el consumo del bimestre y no la lectura acumulada del medidor.`;
    case 'above_table':
      return `El consumo (${kwh} kWh bimestrales) está por encima del último rango de este tipo de proyecto. Agrega un rango que lo cubra, o cotiza este proyecto a la medida.`;
    case 'low_confidence':
      return 'Solo se pudo leer un periodo. Un promedio bimestral necesita al menos dos para no sobre o subdimensionar el sistema. Sube la página del historial de consumo, o captúralo a mano abajo.';
    case 'needs_review':
      if (reason === 'missing_current_period') {
        return 'No se leyó el consumo del bimestre actual, así que el promedio salió solo del historial. Revísalo abajo y complétalo antes de cotizar.';
      }
      if (reason === 'anomalous_history_high') {
        return `El historial trae un bimestre de ${outlierKwh} kWh, muy por encima del resto (un pico real, o un número mal leído). Confírmalo con el cliente, o cotiza con estos datos si así es su consumo.`;
      }
      return `El historial trae un bimestre de ${outlierKwh} kWh, muy por debajo del resto (casa desocupada o en obra). Confírmalo con el cliente, o cotiza con estos datos si así es su consumo.`;
    default:
      return 'No se pudo cotizar con este recibo.';
  }
}

/**
 * The reading, as the review card needs it back. Only the fields the
 * user can see and correct — the derived ones (promedio, costo del
 * periodo) are recomputed from these on the next round trip, so
 * shipping them would just be a second copy to disagree with.
 */
function toManualReading(r: ReceiptExtraction): ManualMeterReading {
  return {
    consumo_periodo_actual_kwh: r.consumo_periodo_actual_kwh,
    historial_bimestres_kwh: r.historial_bimestres_kwh,
    importe_periodo_mxn: r.importe_periodo_mxn,
    importe_dap_mxn: r.importe_dap_mxn,
    historial_bimestres_importe_mxn: r.historial_bimestres_importe_mxn,
    tarifa: r.tarifa,
    ciudad: r.ciudad,
    numero_servicio: r.numero_servicio,
  };
}

/**
 * POST /api/quotes/generate  (agent+, multipart/form-data)
 *
 * Read a CFE receipt, price it against a project type's own table, and
 * fill a template with the result.
 *
 * Deliberately does not touch `deals.quote_url` / `panel_count` — those
 * belong to the WhatsApp bot's flow, and a second writer would corrupt
 * its bookkeeping. The `quotes` row is this path's own record.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const perUser = checkRateLimit(
      `quote-generate:${userId}`,
      RATE_LIMITS.quoteGenerate
    );
    if (!perUser.success) return rateLimitResponse(perUser);
    const perAccount = checkRateLimit(
      `quote-generate-account:${accountId}`,
      RATE_LIMITS.quoteGenerateAccount
    );
    if (!perAccount.success) return rateLimitResponse(perAccount);

    const form = await request.formData().catch(() => null);
    if (!form) {
      return NextResponse.json(
        { error: 'Solicitud inválida.' },
        { status: 400 }
      );
    }
    const contactIdRaw = form.get('contact_id');
    const clientNameRaw = form.get('client_name');
    const projectTypeId = form.get('project_type_id');
    const templateId = form.get('template_id');
    if (typeof projectTypeId !== 'string' || typeof templateId !== 'string') {
      return NextResponse.json(
        { error: 'Elige un tipo de proyecto y una plantilla.' },
        { status: 400 }
      );
    }
    // The contact is optional: leads that arrive off-channel are quoted
    // by name alone, without being invented as CRM rows first.
    const contactId =
      typeof contactIdRaw === 'string' && contactIdRaw ? contactIdRaw : null;
    const typedName =
      typeof clientNameRaw === 'string'
        ? clientNameRaw.trim().slice(0, CLIENT_NAME_MAX)
        : '';
    if (!contactId && !typedName) {
      return NextResponse.json(
        { error: 'Elige un contacto o escribe el nombre del cliente.' },
        { status: 400 }
      );
    }

    // Numbers typed by hand: either corrections to a read that came back
    // wrong, or a quote for a customer who never sent a bill at all.
    // Their presence replaces the vision call entirely.
    const manualRaw = form.get('manual_reading');
    const manualReadings =
      typeof manualRaw === 'string' && manualRaw
        ? parseManualReadings(manualRaw)
        : null;
    if (typeof manualRaw === 'string' && manualRaw && !manualReadings) {
      return NextResponse.json(
        { error: 'Los datos capturados no son válidos. Revísalos.' },
        { status: 400 }
      );
    }
    if (manualReadings && !manualReadings.every(hasConsumption)) {
      return NextResponse.json(
        {
          error:
            'Cada medidor necesita al menos el consumo del bimestre actual o un valor del historial.',
        },
        { status: 400 }
      );
    }

    const meterGroups = readMeterGroups(form);
    if (meterGroups.length === 0 && !manualReadings) {
      return NextResponse.json(
        {
          error:
            'Adjunta al menos una foto o PDF del recibo CFE, o captura el consumo a mano.',
        },
        { status: 400 }
      );
    }
    if (meterGroups.some((g) => g.some((f) => f.size > RECEIPT_MAX_BYTES))) {
      return NextResponse.json(
        { error: 'Cada archivo del recibo debe pesar menos de 16 MB.' },
        { status: 400 }
      );
    }

    // RLS scopes all three to the account, so a foreign id reads as
    // missing rather than leaking that it exists.
    const [contactRes, projectTypeRes, templateRes] = await Promise.all([
      contactId
        ? supabase
            .from('contacts')
            .select('id, name')
            .eq('id', contactId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from('quote_project_types')
        .select(PROJECT_TYPE_SELECT)
        .eq('id', projectTypeId)
        .maybeSingle(),
      supabase
        .from('quote_templates')
        .select('*')
        .eq('id', templateId)
        .maybeSingle(),
    ]);

    const contact = contactRes.data as {
      id: string;
      name: string | null;
    } | null;
    const projectType = projectTypeRes.data as
      (QuoteProjectType & { quote_rate_tiers: QuoteRateTier[] }) | null;
    const template = templateRes.data as QuoteTemplate | null;

    if (contactId && !contact) {
      return NextResponse.json(
        { error: 'Contacto no encontrado.' },
        { status: 404 }
      );
    }

    // What actually gets printed: a name typed for this quote wins over
    // the contact's own, so a WhatsApp nickname never reaches a document
    // — without renaming the contact behind the user's back.
    const clientName = typedName || contact?.name || null;
    if (!clientName) {
      return NextResponse.json(
        {
          error:
            'Ese contacto no tiene nombre. Escribe el nombre del cliente para la propuesta.',
        },
        { status: 400 }
      );
    }
    if (!projectType) {
      return NextResponse.json(
        { error: 'Tipo de proyecto no encontrado.' },
        { status: 404 }
      );
    }
    if (!template) {
      return NextResponse.json(
        { error: 'Plantilla no encontrada.' },
        { status: 404 }
      );
    }

    const tiers = toSolarTiers(projectType.quote_rate_tiers ?? []);
    if (tiers.length === 0) {
      return NextResponse.json(
        {
          error: `El tipo de proyecto "${projectType.name}" no tiene rangos de precio. Agrégalos en Reglas de cálculo.`,
        },
        { status: 400 }
      );
    }

    // Both producers of a reading converge on this array, in the same
    // shape: `buildExtraction` is the derivation the model's own JSON
    // goes through, so nothing downstream can tell them apart.
    const readings: ReceiptExtraction[] = [];

    if (manualReadings) {
      // Hand-captured numbers must quote even on an account with no AI
      // key at all — no vision call, so no config needed.
      readings.push(...manualReadings.map(buildExtraction));
    } else {
      const aiConfig = await loadAiConfig(supabase, accountId, {
        requireActive: false,
      });
      if (!aiConfig) {
        return NextResponse.json(
          {
            error:
              'La lectura de recibos usa el agente de IA, que aún no está configurado. Añade tu API key en Ajustes, o captura el consumo a mano.',
          },
          { status: 400 }
        );
      }

      // One vision call per meter. Each group is read on its own with
      // the single-bill prompt, exactly as a one-meter quote always
      // was, and the sum happens afterwards in code.
      for (const [index, group] of meterGroups.entries()) {
        const files: MediaFile[] = await Promise.all(
          group.map(async (f) => ({
            base64: Buffer.from(await f.arrayBuffer()).toString('base64'),
            mimeType: f.type || 'image/jpeg',
          }))
        );

        // extractReceiptFromFiles throws on a provider/network failure
        // and returns null on an unreadable image — the two need
        // different answers, which is why this path calls it rather
        // than the bot's swallow-everything extractReceipts.
        let extracted;
        try {
          extracted = await extractReceiptFromFiles(aiConfig, files, {
            accountId,
            source: 'cotizador',
            // No conversation here, and the contact is null when the
            // quote is being drawn up before one exists.
            contactId,
          });
        } catch (err) {
          console.error('[quotes/generate] vision call failed:', err);
          return NextResponse.json(
            {
              error:
                'El proveedor de IA no respondió. Vuelve a intentarlo en un momento.',
            },
            { status: 502 }
          );
        }
        // An unreadable meter no longer ends the road: the response
        // carries an empty block per meter so the review card can open
        // on it and the user can type the numbers off the bill in front
        // of them. Pricing the meters that DID read is still refused —
        // that silently sizes the system for part of the property.
        if (!extracted) {
          return NextResponse.json(
            {
              error:
                meterGroups.length > 1
                  ? `No se pudo leer el recibo del medidor ${index + 1}. ${explainRefusal('unreadable')}`
                  : explainRefusal('unreadable'),
              readings: meterGroups.map(() => emptyManualReading()),
            },
            { status: 422 }
          );
        }
        readings.push(extracted);
      }
    }

    // Two groups can turn out to be one meter — the same bill uploaded
    // twice. Counting it twice would double a real customer's
    // consumption and sell them a system twice the size they need, so
    // the duplicate is dropped and called out rather than trusted.
    const meters: ReceiptExtraction[] = [];
    let duplicateMeters = 0;
    for (const reading of readings) {
      if (meters.some((m) => sameMeter(m, reading))) duplicateMeters += 1;
      else meters.push(reading);
    }
    const extraction = combineReadings(meters);

    const resolution = resolveQuote(
      extraction.promedio_bimestral_kwh,
      extraction.cantidad_periodos_usados,
      {
        includesCurrentPeriod: extraction.incluye_periodo_actual,
        periods: extraction.periodos_promediados_kwh,
      },
      tiers
    );

    // Warnings the document carries; the refusal path below never gets
    // here, so anything pushed after this point ends up on the quote.
    const warnings: string[] = [];

    // A resolution that carries a tier, once the review gate has had
    // its say. `needs_review` asks a question ("is this really how they
    // live?") that hand-capture has already answered: someone had the
    // bill in front of them and typed these numbers. Blocking again
    // would leave the same dead end the review card exists to open. The
    // other refusals are not questions — an implausible average, or one
    // past the table, is wrong however it was entered — so they stand.
    let quote: { kwh: number; tier: SolarTier } | null = null;
    if (resolution.kind === 'ok') {
      quote = resolution;
    } else if (resolution.kind === 'needs_review' && manualReadings) {
      warnings.push(
        resolution.reason === 'missing_current_period'
          ? 'Se cotizó sin el consumo del bimestre actual: el promedio salió solo del historial.'
          : resolution.reason === 'anomalous_history_high'
            ? `Se cotizó con un historial irregular: un bimestre de ${resolution.outlierKwh} kWh, muy por encima del resto.`
            : `Se cotizó con un historial irregular: un bimestre de ${resolution.outlierKwh} kWh, muy por debajo del resto.`
      );
      quote = resolution;
    }

    if (!quote) {
      return NextResponse.json(
        {
          error: explainRefusal(
            resolution.kind,
            'kwh' in resolution ? resolution.kwh : undefined,
            resolution.kind === 'needs_review' ? resolution.reason : undefined,
            resolution.kind === 'needs_review'
              ? resolution.outlierKwh
              : undefined
          ),
          // What the model actually read, so the review card opens on
          // it instead of leaving the user with a sentence and no way
          // forward. Per meter, in the order they were uploaded.
          readings: readings.map(toManualReading),
        },
        { status: 422 }
      );
    }

    // Said out loud on the document's own warnings, not just in the
    // banner: months later, "where did this number come from?" is
    // answered by the quote record itself.
    if (manualReadings) {
      warnings.push('Consumo capturado a mano, no leído del recibo.');
    }

    const constants = toFinanceConstants(projectType);
    const financials = buildFinancials({
      costoBimestralMxn: projectionBaseCost({
        costoPeriodoMxn: extraction.costo_periodo_mxn,
        historialImporteMxn: extraction.historial_bimestres_importe_mxn,
      }),
      tier: quote.tier,
      constants,
    });

    // Non-blocking: the tariff on the bill is evidence, not authority —
    // a business can genuinely sit on a residential meter.
    const receiptHint = inferPropertyType(extraction.tarifa);
    if (
      receiptHint &&
      projectType.cfe_property_type_hint &&
      receiptHint !== projectType.cfe_property_type_hint
    ) {
      warnings.push(
        `El recibo tiene tarifa ${extraction.tarifa} (${receiptHint}), pero cotizaste como "${projectType.name}" (${projectType.cfe_property_type_hint}). Verifica que sea el tipo de proyecto correcto.`
      );
    }
    if (!financials) {
      warnings.push(
        'El recibo no traía un importe legible, así que la propuesta va sin la proyección de ahorro.'
      );
    }
    // Stated back so the figure on the document can be checked against
    // the bills on the desk: a sum is not something the reader can
    // verify by looking at any single receipt.
    if (meters.length > 1) {
      warnings.push(
        `Se sumaron ${meters.length} medidores: ${quote.kwh} kWh bimestrales en total.`
      );
    }
    if (duplicateMeters > 0) {
      warnings.push(
        duplicateMeters === 1
          ? 'Dos de los recibos que subiste son del mismo medidor, así que se contó una sola vez.'
          : `${duplicateMeters + 1} de los recibos que subiste son del mismo medidor, así que se contó una sola vez.`
      );
    }
    if (extraction.advertencias) warnings.push(extraction.advertencias);

    // The project type is in the seed because two types can resolve to
    // the same panel count, and two documents that differ on price must
    // not share a folio.
    const now = new Date();
    // Seeded by contact when there is one, else by the name typed — so a
    // re-quote for the same person and system reproduces the folio they
    // already wrote down, either way.
    const folioSeed = contact?.id ?? `name:${clientName.toLowerCase()}`;
    const folio = buildFolio(
      now,
      `${folioSeed}:${quote.tier.panels}:${projectTypeId}`
    );

    const values = buildQuoteMergeFields({
      nombre: clientName,
      tier: quote.tier,
      folio,
      now,
      financials,
      tipoProyecto: projectType.name,
      ciudad: extraction.ciudad,
      consumoKwh: quote.kwh,
    });

    const { data: templateBlob, error: downloadError } = await supabase.storage
      .from(QUOTE_ASSETS_BUCKET)
      .download(template.storage_path);
    if (downloadError || !templateBlob) {
      console.error(
        '[quotes/generate] template download failed:',
        downloadError
      );
      return NextResponse.json(
        { error: 'No se pudo abrir la plantilla. Vuelve a subirla.' },
        { status: 500 }
      );
    }

    let output: Buffer;
    try {
      output = renderQuoteTemplate(
        Buffer.from(await templateBlob.arrayBuffer()),
        values
      );
    } catch (err) {
      if (err instanceof TemplateParseError) {
        return NextResponse.json({ error: err.message }, { status: 500 });
      }
      throw err;
    }

    // A PowerPoint template is delivered as PDF: it is what gets sent to
    // the customer, and it renders the same everywhere. A .docx has no
    // in-process converter, so it is delivered as authored — the user
    // exports it from Word, the way the manual flow always worked.
    let extension: QuoteTemplateFileType | 'pdf' = template.file_type;
    if (template.file_type === 'pptx') {
      try {
        output = Buffer.from(await convertPptxToPdf(output));
        extension = 'pdf';
      } catch (err) {
        if (err instanceof PptxConvertError) {
          return NextResponse.json({ error: err.message }, { status: 500 });
        }
        throw err;
      }
    }

    // The financing annex, when the user asked for it. Opt-in rather
    // than automatic like the bot's: a template that already carries its
    // own financing section would otherwise quote the instalments twice.
    //
    // Where it lands depends on what we can deliver. A .pptx is already
    // one converted PDF, so the annex becomes its last page and the
    // customer gets a single document. A .docx has no in-process
    // converter (see below), so it travels beside it as its own file.
    const includeFinancing = form.get('include_financing') === 'true';
    let financingOutput: Buffer | null = null;
    if (includeFinancing) {
      try {
        if (extension === 'pdf') {
          output = Buffer.from(await appendFinancingAnnex(output, values));
        } else {
          financingOutput = Buffer.from(
            await extractFinancingAnnexPage(values)
          );
        }
      } catch (err) {
        console.error('[quotes/generate] financing annex failed:', err);
        return NextResponse.json(
          { error: 'No se pudo generar la hoja de financiamiento.' },
          { status: 500 }
        );
      }
      // The annex is priced off the tier alone, so it comes out blank
      // only when the tier itself has no price — reachable here, unlike
      // in the bot, because the rate table is the account's own and the
      // zero-price check only runs in the browser. Said out loud rather
      // than blocked: same call as the savings projection above.
      if (!values.enganche) {
        warnings.push(
          'La hoja de financiamiento salió sin montos: el rango de precio con el que se cotizó no permite calcularlos.'
        );
      }
    }

    const mimeType = templateMimeType(extension);
    const safeName = clientName.replace(/[^\p{L}\p{N} .-]/gu, '');
    const { publicUrl, path } = await uploadServerMedia({
      db: supabase,
      bucket: QUOTE_ASSETS_BUCKET,
      accountId,
      bytes: output,
      fileName: `${folio} ${safeName}.${extension}`,
      contentType: mimeType,
    });

    // The annex as its own download, for the .docx case above. Uploaded
    // rather than streamed back so both files are fetched the same way,
    // and so the link survives a page reload like the proposal's does.
    let financingDownloadUrl: string | null = null;
    if (financingOutput) {
      const uploaded = await uploadServerMedia({
        db: supabase,
        bucket: QUOTE_ASSETS_BUCKET,
        accountId,
        bytes: financingOutput,
        fileName: `${folio} ${safeName} - Financiamiento.pdf`,
        contentType: templateMimeType('pdf'),
      });
      financingDownloadUrl = uploaded.publicUrl;
    }

    // Audit copy of what was read. Best effort — a failure here must not
    // cost the user the document they just waited for. There is nothing
    // to archive when the numbers were typed with no bill attached; a
    // hand-corrected read still archives its photo, so the evidence
    // behind the quote does not go missing.
    let receiptPath: string | null = null;
    if (meterGroups.length > 0) {
      try {
        const first = meterGroups[0][0];
        const uploaded = await uploadServerMedia({
          db: supabase,
          bucket: QUOTE_ASSETS_BUCKET,
          accountId,
          bytes: Buffer.from(await first.arrayBuffer()),
          fileName: `${folio} recibo-${first.name}`,
          contentType: first.type || 'image/jpeg',
        });
        receiptPath = uploaded.path;
      } catch (err) {
        console.error('[quotes/generate] receipt archive failed:', err);
      }
    }

    // Keeps the contact card in step with the bot's own reads. Skipped
    // for an off-channel quote: there is no card to update.
    if (contact) {
      void saveReceiptData(supabase, {
        accountId,
        userId,
        contactId: contact.id,
        extraction,
      }).catch((err) =>
        console.error('[quotes/generate] saveReceiptData failed:', err)
      );
    }

    const { data: created, error: insertError } = await supabase
      .from('quotes')
      .insert({
        account_id: accountId,
        contact_id: contact?.id ?? null,
        client_name: clientName,
        project_type_id: projectTypeId,
        template_id: templateId,
        created_by: userId,
        folio,
        consumo_kwh: quote.kwh,
        panels: quote.tier.panels,
        system_kw: quote.tier.systemKw,
        price_mxn: quote.tier.priceMxn,
        financials,
        source_tarifa: extraction.tarifa,
        source_ciudad: extraction.ciudad,
        property_type_hint: receiptHint,
        receipt_storage_path: receiptPath,
        output_storage_path: path,
        output_mime_type: mimeType,
        output_url: publicUrl,
        warnings: warnings.length > 0 ? warnings.join(' ') : null,
      })
      .select('*')
      .single();
    if (insertError) {
      // The document exists and is downloadable; only the record failed.
      console.error('[quotes/generate] quote insert failed:', insertError);
      return NextResponse.json({
        success: true,
        download_url: publicUrl,
        financing_download_url: financingDownloadUrl,
        folio,
        warning:
          'La cotización se generó, pero no se pudo guardar en el historial.',
      });
    }

    return NextResponse.json({
      success: true,
      quote: created,
      download_url: publicUrl,
      financing_download_url: financingDownloadUrl,
      folio,
      warning: warnings.length > 0 ? warnings.join(' ') : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
