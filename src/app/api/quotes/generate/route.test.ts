import { beforeEach, describe, it, expect, vi } from 'vitest';
import { POST, readMeterGroups } from './route';
import {
  appendFinancingAnnex,
  extractFinancingAnnexPage,
} from '@/lib/quotes/financing-annex';

/**
 * The form contract between the Cotizador panel and this route: bills
 * grouped by meter under `receipt_files_<n>`. Worth guarding on its own
 * because a mismatch here fails silently in the worst possible
 * direction — the quote still generates, just for fewer meters than the
 * customer has.
 */
function file(name: string): File {
  return new File(['x'], name, { type: 'application/pdf' });
}

describe('readMeterGroups', () => {
  it('reads one group per meter, in order', () => {
    const form = new FormData();
    form.append('receipt_files_0', file('medidor-a.pdf'));
    form.append('receipt_files_1', file('medidor-b.pdf'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(2);
    expect(groups[0][0].name).toBe('medidor-a.pdf');
    expect(groups[1][0].name).toBe('medidor-b.pdf');
  });

  it('keeps a meter’s pages together in its own group', () => {
    const form = new FormData();
    form.append('receipt_files_0', file('pagina-1.jpg'));
    form.append('receipt_files_0', file('pagina-2.jpg'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('closes the gap when a middle meter was removed in the UI', () => {
    // React keys by index, so removing meter 2 of 3 can post 0 and 2.
    // Treating that as three meters would send an empty group into the
    // vision call and fail a quote that is perfectly complete.
    const form = new FormData();
    form.append('receipt_files_0', file('a.pdf'));
    form.append('receipt_files_2', file('c.pdf'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(2);
    expect(groups[1][0].name).toBe('c.pdf');
  });

  it('caps the files inside one meter', () => {
    const form = new FormData();
    for (let i = 0; i < 6; i++) {
      form.append('receipt_files_0', file(`p${i}.jpg`));
    }
    expect(readMeterGroups(form)[0]).toHaveLength(3);
  });

  it('caps how many meters one quote covers', () => {
    const form = new FormData();
    for (let i = 0; i < 8; i++) {
      form.append(`receipt_files_${i}`, file(`m${i}.pdf`));
    }
    expect(readMeterGroups(form)).toHaveLength(4);
  });

  it('reads the flat field as a single meter', () => {
    // What the panel posted before meters existed.
    const form = new FormData();
    form.append('receipt_files', file('recibo.pdf'));
    form.append('receipt_files', file('recibo-p2.pdf'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('prefers the grouped fields when both are present', () => {
    const form = new FormData();
    form.append('receipt_files', file('viejo.pdf'));
    form.append('receipt_files_0', file('nuevo.pdf'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(1);
    expect(groups[0][0].name).toBe('nuevo.pdf');
  });

  it('reports nothing when no bill was attached', () => {
    expect(readMeterGroups(new FormData())).toEqual([]);
  });

  it('ignores non-file values posted under the field name', () => {
    const form = new FormData();
    form.append('receipt_files_0', 'not-a-file');
    expect(readMeterGroups(form)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The hand-capture path. A CFE bill photographed in cropped fragments is the
// normal case, not the exception, and before this existed a read the model got
// wrong ended the road: the route refused with one sentence and no way to
// correct it. These cover the decisions that path turns on — everything else
// (storage, template rendering, the PDF itself) is mocked, because none of it
// is what can go wrong here.
// ---------------------------------------------------------------------------

const TIERS = [
  { min_kwh: 0, max_kwh: 704, panels: 4, system_kw: 2.5, price_mxn: 43200 },
  { min_kwh: 705, max_kwh: 1024, panels: 6, system_kw: 3.75, price_mxn: 62400 },
  { min_kwh: 1025, max_kwh: 1344, panels: 8, system_kw: 5, price_mxn: 75500 },
];

const PROJECT_TYPE = {
  id: 'pt-1',
  name: 'Residencial',
  cfe_property_type_hint: 'Casa',
  annual_inflation: 0.06,
  fixed_charge_bimonthly_mxn: 120,
  peak_sun_hours: 5.5,
  system_efficiency: 0.8,
  horizon_years: 25,
  quote_rate_tiers: TIERS,
};

/**
 * Mutable in `file_type` alone: the annex is merged into a .pptx (which
 * already converts to one PDF) but delivered beside a .docx, and that
 * fork is the whole point of the financing tests below.
 */
const TEMPLATE = {
  id: 'tpl-1',
  name: 'Propuesta',
  file_type: 'docx' as 'docx' | 'pptx',
  storage_path: 'templates/propuesta.docx',
};

/**
 * The raw JSON the vision model "returns" this test, or null for an
 * unreadable image. Run through the real `buildExtraction` by the mock
 * below, exactly as `extractReceiptFromFiles` does — stubbing that
 * derivation would test the mock instead of the route.
 */
let visionResult: Record<string, unknown> | null = null;
/** The row handed back by the `quotes` insert. */
const quoteInserts: Array<Record<string, unknown>> = [];

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    supabase: makeSupabase(),
    accountId: 'acct-1',
    userId: 'user-1',
  })),
  toErrorResponse: (err: unknown) => {
    throw err;
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('rate limited', { status: 429 }),
  RATE_LIMITS: { quoteGenerate: {}, quoteGenerateAccount: {} },
}));

vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: vi.fn(async () => ({
    provider: 'anthropic',
    visionModel: 'claude-x',
    apiKey: 'k',
  })),
}));

vi.mock('@/lib/ai/receipt', async (importOriginal) => {
  // `buildExtraction` and `inferPropertyType` are the real thing: the
  // whole point of the manual path is that it runs the same derivation
  // the model's output runs through, so stubbing it would test nothing.
  const actual = await importOriginal<typeof import('@/lib/ai/receipt')>();
  return {
    ...actual,
    extractReceiptFromFiles: vi.fn(async () =>
      visionResult ? actual.buildExtraction(visionResult) : null
    ),
    saveReceiptData: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/quotes/template-render', () => ({
  renderQuoteTemplate: () => Buffer.from('documento'),
  TemplateParseError: class TemplateParseError extends Error {},
}));

vi.mock('@/lib/quotes/pptx-to-pdf', () => ({
  convertPptxToPdf: async (b: Buffer) => b,
  PptxConvertError: class PptxConvertError extends Error {},
}));

// Stubbed like the two above: what the route decides here is WHICH
// annex path runs and whether a second file goes out — the PDF page
// surgery itself is covered, unmocked, in financing-annex.test.ts.
vi.mock('@/lib/quotes/financing-annex', () => ({
  appendFinancingAnnex: vi.fn(async (bytes: Uint8Array) =>
    Buffer.concat([Buffer.from(bytes), Buffer.from(' + anexo')])
  ),
  extractFinancingAnnexPage: vi.fn(async () => Buffer.from('anexo suelto')),
}));

/** Every file the route uploaded, in order. */
const uploads: Array<{ fileName: string; contentType: string }> = [];

vi.mock('@/lib/storage/upload-server', () => ({
  uploadServerMedia: async (args: {
    fileName: string;
    contentType: string;
  }) => {
    uploads.push({ fileName: args.fileName, contentType: args.contentType });
    return {
      publicUrl: `https://example.test/${uploads.length}-${args.fileName}`,
      path: `quotes/${args.fileName}`,
    };
  },
}));

function makeSupabase() {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = self;
    chain.eq = self;
    chain.insert = (row: Record<string, unknown>) => {
      quoteInserts.push(row);
      return chain;
    };
    chain.maybeSingle = async () => ({
      data:
        table === 'quote_project_types'
          ? PROJECT_TYPE
          : table === 'quote_templates'
            ? TEMPLATE
            : null,
      error: null,
    });
    chain.single = async () => ({
      data: { id: 'quote-1', ...quoteInserts[quoteInserts.length - 1] },
      error: null,
    });
    return chain;
  };
  return {
    from: (table: string) => builder(table),
    storage: {
      from: () => ({
        download: async () => ({
          data: { arrayBuffer: async () => new ArrayBuffer(8) },
          error: null,
        }),
      }),
    },
  };
}

/** The form the panel posts, minus whatever a test wants to leave out. */
function quoteForm(fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('client_name', 'Saez');
  form.append('project_type_id', 'pt-1');
  form.append('template_id', 'tpl-1');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

function post(form: FormData): Promise<Response> {
  return POST(
    new Request('http://localhost/api/quotes/generate', {
      method: 'POST',
      body: form,
    })
  );
}

describe('POST /api/quotes/generate — hand-captured readings', () => {
  beforeEach(() => {
    visionResult = null;
    quoteInserts.length = 0;
  });

  it('quotes from typed numbers with no bill attached at all', async () => {
    const res = await post(
      quoteForm({
        manual_reading: JSON.stringify([
          {
            consumo_periodo_actual_kwh: 1611,
            historial_bimestres_kwh: [1220, 683, 328, 655, 1060],
            importe_periodo_mxn: 3634.31,
            importe_dap_mxn: 156.65,
            tarifa: '1D',
            ciudad: 'Cancún',
          },
        ]),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // 5,557 kWh over six periods → 926, the 705–1,024 band.
    expect(quoteInserts[0].consumo_kwh).toBe(926);
    expect(quoteInserts[0].panels).toBe(6);
    expect(quoteInserts[0].warnings).toContain('capturado a mano');
  });

  it('quotes an irregular history instead of blocking, and says so', async () => {
    // A genuinely empty bimester. Read off a photo this is refused and
    // the bot asks the customer; typed by hand, the person doing the
    // typing IS the answer to that question — so it prices, with the
    // reason recorded on the quote rather than swallowed.
    const res = await post(
      quoteForm({
        manual_reading: JSON.stringify([
          {
            consumo_periodo_actual_kwh: 1126,
            historial_bimestres_kwh: [879, 1067, 1485, 216],
          },
        ]),
      })
    );

    expect(res.status).toBe(200);
    expect(quoteInserts[0].warnings).toContain('216 kWh');
    expect(quoteInserts[0].warnings).toContain('historial irregular');
  });

  it('still refuses a typed average no real bill would show', async () => {
    const res = await post(
      quoteForm({
        manual_reading: JSON.stringify([
          { consumo_periodo_actual_kwh: 4, historial_bimestres_kwh: [6] },
        ]),
      })
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('no parece el de un recibo');
    expect(quoteInserts).toHaveLength(0);
  });

  it('refuses a meter added and left blank', async () => {
    const res = await post(
      quoteForm({
        manual_reading: JSON.stringify([
          { consumo_periodo_actual_kwh: 900, historial_bimestres_kwh: [880] },
          { consumo_periodo_actual_kwh: null, historial_bimestres_kwh: [] },
        ]),
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('al menos el consumo');
  });

  it('hands back what the model read when it refuses, per meter', async () => {
    // The dead end this whole path exists to open: the refusal carries
    // the numbers, so the review card fills in rather than starting
    // blank. 328 kWh is a Cancún winter, not an empty house — but even
    // when the rule does fire, the user can see and correct it.
    visionResult = {
      consumo_periodo_actual_kwh: null,
      historial_bimestres_kwh: [1220, 683, 328],
      tarifa: '1D',
      ciudad: 'Cancún',
      advertencias: '',
    };
    const form = quoteForm();
    form.append(
      'receipt_files_0',
      new File(['x'], 'recibo.jpg', { type: 'image/jpeg' })
    );

    const res = await post(form);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('bimestre actual');
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0].historial_bimestres_kwh).toEqual([1220, 683, 328]);
    expect(body.readings[0].ciudad).toBe('Cancún');
  });

  it('opens the card on an empty block when the photo was unreadable', async () => {
    visionResult = null;
    const form = quoteForm();
    form.append(
      'receipt_files_0',
      new File(['x'], 'techo.jpg', { type: 'image/jpeg' })
    );

    const res = await post(form);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.readings).toHaveLength(1);
    expect(body.readings[0].consumo_periodo_actual_kwh).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The financing annex. Opt-in, and delivered two different ways: merged into
// a .pptx's converted PDF, or as its own file beside a .docx. Both forks are
// invisible in the response body except through the second URL, which is
// exactly what a regression here would get wrong.
// ---------------------------------------------------------------------------

describe('POST /api/quotes/generate — the financing annex', () => {
  /** A reading that prices cleanly, so every test below reaches the annex. */
  const READING = JSON.stringify([
    { consumo_periodo_actual_kwh: 900, historial_bimestres_kwh: [880, 920] },
  ]);

  beforeEach(() => {
    visionResult = null;
    quoteInserts.length = 0;
    uploads.length = 0;
    TEMPLATE.file_type = 'docx';
    vi.mocked(appendFinancingAnnex).mockClear();
    vi.mocked(extractFinancingAnnexPage).mockClear();
  });

  it('leaves the document alone when the box is unchecked', async () => {
    const res = await post(quoteForm({ manual_reading: READING }));

    expect(res.status).toBe(200);
    expect(appendFinancingAnnex).not.toHaveBeenCalled();
    expect(extractFinancingAnnexPage).not.toHaveBeenCalled();
    expect((await res.json()).financing_download_url).toBeNull();
    // One upload: the proposal itself, and nothing beside it.
    expect(uploads).toHaveLength(1);
  });

  it('sends the annex as its own PDF beside a Word template', async () => {
    const res = await post(
      quoteForm({ manual_reading: READING, include_financing: 'true' })
    );

    expect(res.status).toBe(200);
    expect(extractFinancingAnnexPage).toHaveBeenCalledTimes(1);
    expect(appendFinancingAnnex).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.financing_download_url).toContain('Financiamiento.pdf');
    expect(uploads).toHaveLength(2);
    expect(uploads[1].contentType).toBe('application/pdf');
    expect(uploads[1].fileName).toContain('Financiamiento');
  });

  it('merges the annex into a PowerPoint template’s single PDF', async () => {
    TEMPLATE.file_type = 'pptx';

    const res = await post(
      quoteForm({ manual_reading: READING, include_financing: 'true' })
    );

    expect(res.status).toBe(200);
    expect(appendFinancingAnnex).toHaveBeenCalledTimes(1);
    expect(extractFinancingAnnexPage).not.toHaveBeenCalled();
    // One document, not two — the annex is inside it.
    expect((await res.json()).financing_download_url).toBeNull();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].contentType).toBe('application/pdf');
  });

  it('passes the quoted values through, so the annex prices this quote', async () => {
    await post(
      quoteForm({ manual_reading: READING, include_financing: 'true' })
    );

    // 900 kWh → the 705–1,024 band → the 6-panel, $62,400 tier. The
    // annex has to be built from THAT price, not a default.
    const [values] = vi.mocked(extractFinancingAnnexPage).mock.calls[0];
    expect(values.paneles).toBe('6');
    expect(values.enganche).toBeTruthy();
  });
});
