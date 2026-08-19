import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import {
  extractReceiptFromFiles,
  inferPropertyType,
  saveReceiptData,
  type MediaFile,
} from '@/lib/ai/receipt';
import { resolveQuote } from '@/lib/quotes/pricing';
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
import { uploadServerMedia } from '@/lib/storage/upload-server';
import type {
  QuoteProjectType,
  QuoteRateTier,
  QuoteTemplate,
  QuoteTemplateFileType,
} from '@/types';

/** A CFE bill is commonly two pages, photographed separately. */
const MAX_RECEIPT_FILES = 3;
const RECEIPT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Why a reading can be priced in chat but must not become a document.
 * The bot skips these silently and asks the customer a question; here a
 * person is waiting, so each one is said out loud.
 */
function explainRefusal(kind: string, kwh?: number): string {
  switch (kind) {
    case 'unreadable':
      return 'No se pudo leer el consumo del recibo. Sube una foto más nítida de la primera página, donde viene el renglón "Energía (kWh)".';
    case 'implausible':
      return `El consumo leído (${kwh} kWh bimestrales) no parece el de un recibo real. Revisa que la foto sea del recibo completo y no de la lectura del medidor.`;
    case 'above_table':
      return `El consumo (${kwh} kWh bimestrales) está por encima del último rango de este tipo de proyecto. Agrega un rango que lo cubra, o cotiza este proyecto a la medida.`;
    case 'low_confidence':
      return 'El recibo solo dejó leer un periodo. Un promedio bimestral necesita al menos dos para no sobre o subdimensionar el sistema — sube también la página del historial de consumo.';
    case 'needs_review':
      return 'La lectura salió irregular: falta el bimestre actual, o el historial trae un periodo muy por debajo del promedio (casa desocupada o en obra). Confírmalo con el cliente antes de cotizar.';
    default:
      return 'No se pudo cotizar con este recibo.';
  }
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
    const contactId = form.get('contact_id');
    const projectTypeId = form.get('project_type_id');
    const templateId = form.get('template_id');
    if (
      typeof contactId !== 'string' ||
      typeof projectTypeId !== 'string' ||
      typeof templateId !== 'string'
    ) {
      return NextResponse.json(
        { error: 'Elige un contacto, un tipo de proyecto y una plantilla.' },
        { status: 400 }
      );
    }

    const receiptFiles = form
      .getAll('receipt_files')
      .filter((f): f is File => f instanceof File)
      .slice(0, MAX_RECEIPT_FILES);
    if (receiptFiles.length === 0) {
      return NextResponse.json(
        { error: 'Adjunta al menos una foto o PDF del recibo CFE.' },
        { status: 400 }
      );
    }
    if (receiptFiles.some((f) => f.size > RECEIPT_MAX_BYTES)) {
      return NextResponse.json(
        { error: 'Cada archivo del recibo debe pesar menos de 16 MB.' },
        { status: 400 }
      );
    }

    // RLS scopes all three to the account, so a foreign id reads as
    // missing rather than leaking that it exists.
    const [contactRes, projectTypeRes, templateRes] = await Promise.all([
      supabase
        .from('contacts')
        .select('id, name')
        .eq('id', contactId)
        .maybeSingle(),
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

    if (!contact) {
      return NextResponse.json(
        { error: 'Contacto no encontrado.' },
        { status: 404 }
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

    const aiConfig = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    });
    if (!aiConfig) {
      return NextResponse.json(
        {
          error:
            'La lectura de recibos usa el agente de IA, que aún no está configurado. Añade tu API key en Ajustes.',
        },
        { status: 400 }
      );
    }

    const files: MediaFile[] = await Promise.all(
      receiptFiles.map(async (f) => ({
        base64: Buffer.from(await f.arrayBuffer()).toString('base64'),
        mimeType: f.type || 'image/jpeg',
      }))
    );

    // extractReceiptFromFiles throws on a provider/network failure and
    // returns null on an unreadable image — the two need different
    // answers, which is why this path calls it rather than the bot's
    // swallow-everything extractReceipt.
    let extraction;
    try {
      extraction = await extractReceiptFromFiles(aiConfig, files);
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
    if (!extraction) {
      return NextResponse.json(
        { error: explainRefusal('unreadable') },
        { status: 422 }
      );
    }

    const quote = resolveQuote(
      extraction.promedio_bimestral_kwh,
      extraction.cantidad_periodos_usados,
      {
        includesCurrentPeriod: extraction.incluye_periodo_actual,
        periods: extraction.periodos_promediados_kwh,
      },
      tiers
    );
    if (quote.kind !== 'ok') {
      return NextResponse.json(
        {
          error: explainRefusal(
            quote.kind,
            'kwh' in quote ? quote.kwh : undefined
          ),
        },
        { status: 422 }
      );
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
    const warnings: string[] = [];
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
    if (extraction.advertencias) warnings.push(extraction.advertencias);

    // The project type is in the seed because two types can resolve to
    // the same panel count, and two documents that differ on price must
    // not share a folio.
    const now = new Date();
    const folio = buildFolio(
      now,
      `${contact.id}:${quote.tier.panels}:${projectTypeId}`
    );

    const values = buildQuoteMergeFields({
      nombre: contact.name,
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

    const mimeType = templateMimeType(extension);
    const safeName = (contact.name ?? 'cliente').replace(
      /[^\p{L}\p{N} .-]/gu,
      ''
    );
    const { publicUrl, path } = await uploadServerMedia({
      db: supabase,
      bucket: QUOTE_ASSETS_BUCKET,
      accountId,
      bytes: output,
      fileName: `${folio} ${safeName}.${extension}`,
      contentType: mimeType,
    });

    // Audit copy of what was read. Best effort — a failure here must not
    // cost the user the document they just waited for.
    let receiptPath: string | null = null;
    try {
      const first = receiptFiles[0];
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

    // Keeps the contact card in step with the bot's own reads.
    void saveReceiptData(supabase, {
      accountId,
      userId,
      contactId: contact.id,
      extraction,
    }).catch((err) =>
      console.error('[quotes/generate] saveReceiptData failed:', err)
    );

    const { data: created, error: insertError } = await supabase
      .from('quotes')
      .insert({
        account_id: accountId,
        contact_id: contact.id,
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
        folio,
        warning:
          'La cotización se generó, pero no se pudo guardar en el historial.',
      });
    }

    return NextResponse.json({
      success: true,
      quote: created,
      download_url: publicUrl,
      folio,
      warning: warnings.length > 0 ? warnings.join(' ') : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
