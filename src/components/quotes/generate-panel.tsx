'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { addFilesToMeter } from './meter-files';
import { ManualReadingCard } from './manual-reading-card';
import {
  emptyManualReading,
  hasConsumption,
  type ManualMeterReading,
} from '@/lib/quotes/reading';
import type { QuoteProjectType, QuoteTemplate } from '@/types';

interface Props {
  onGoToRules: () => void;
  onGoToTemplates: () => void;
}

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

interface Result {
  downloadUrl: string;
  folio: string;
  warning: string | null;
}

/** Files per meter — a CFE bill is commonly two pages. */
const MAX_RECEIPT_FILES = 3;

/** Meters one quote may cover. Mirrors the route's own ceiling. */
const MAX_METERS = 4;

export function GeneratePanel({ onGoToRules, onGoToTemplates }: Props) {
  const supabase = createClient();
  // One picker per meter, so a click lands in the group it belongs to.
  const fileInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const [projectTypes, setProjectTypes] = useState<QuoteProjectType[]>([]);
  const [templates, setTemplates] = useState<QuoteTemplate[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [projectTypeId, setProjectTypeId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [contactId, setContactId] = useState('');
  const [clientName, setClientName] = useState('');
  /**
   * Bills grouped by meter. Starts as one empty group, so a customer
   * with a single meter sees the form exactly as it always was and
   * never learns this dimension exists.
   *
   * Grouped here rather than inferred server-side because the person
   * uploading can see the bills: nothing in two JPEGs says whether they
   * are two pages of one meter or one page each of two.
   */
  const [meters, setMeters] = useState<File[][]>([[]]);

  /**
   * Whether the consumption is being typed instead of read. Set two
   * ways: by the "Sin recibo" toggle, and automatically when a read
   * comes back refused — at which point `manual` below is pre-filled
   * with whatever the model DID manage to get, so the user corrects a
   * draft rather than starting from a blank form.
   */
  const [manualMode, setManualMode] = useState(false);
  const [manual, setManual] = useState<ManualMeterReading[]>([
    emptyManualReading(),
  ]);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [typesRes, templatesRes, contactsRes] = await Promise.all([
        fetch('/api/quotes/project-types').then((r) => r.json()),
        fetch('/api/quotes/templates').then((r) => r.json()),
        supabase
          .from('contacts')
          .select('id, name, phone')
          .order('name')
          .limit(500),
      ]);
      setProjectTypes(typesRes?.projectTypes ?? []);
      setTemplates(templatesRes?.templates ?? []);
      setContacts((contactsRes.data as ContactOption[] | null) ?? []);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  /**
   * Base UI reads the trigger's label off the root's `items`, not off the
   * rendered options — without it the trigger prints the raw value, which
   * here is a UUID. The empty value stands for "no contact": it leaves the
   * trigger showing its placeholder.
   */
  const contactItems = useMemo(
    () => [
      { value: '', label: 'Sin contacto' },
      ...contacts.map((contact) => ({
        value: contact.id,
        label: contact.name || contact.phone,
      })),
    ],
    [contacts]
  );

  const projectTypeItems = useMemo(
    () => projectTypes.map((type) => ({ value: type.id, label: type.name })),
    [projectTypes]
  );

  const templateItems = useMemo(
    () =>
      templates.map((template) => ({
        value: template.id,
        label: template.name,
      })),
    [templates]
  );

  /**
   * Picking a contact fills the name in rather than locking it: most
   * quotes go out under the contact's own name, but a WhatsApp profile
   * is often a nickname, and the document should carry the real one.
   */
  function pickContact(id: string) {
    setContactId(id);
    const picked = contacts.find((c) => c.id === id);
    // Only overwrite the name when the contact has one to offer —
    // clearing the picker, or choosing a contact saved under just a
    // phone number, leaves whatever was typed alone.
    if (picked?.name) setClientName(picked.name);
  }

  function addFiles(meterIndex: number, picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    // The updater is built now, with the files already copied out of
    // the input's live FileList — see `addFilesToMeter`.
    setMeters(addFilesToMeter(meterIndex, picked, MAX_RECEIPT_FILES));
  }

  function removeFile(meterIndex: number, fileIndex: number) {
    setMeters((prev) =>
      prev.map((group, i) =>
        i === meterIndex ? group.filter((_, j) => j !== fileIndex) : group
      )
    );
  }

  function removeMeter(meterIndex: number) {
    // Never below one group: the form always needs somewhere to drop a
    // bill, and an empty first group is the resting state, not an error.
    setMeters((prev) =>
      prev.length <= 1 ? [[]] : prev.filter((_, i) => i !== meterIndex)
    );
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      body.append('contact_id', contactId);
      body.append('client_name', clientName.trim());
      body.append('project_type_id', projectTypeId);
      body.append('template_id', templateId);
      // Indexed by meter — the route reads `receipt_files_<n>` as one
      // bill each and sums them. Empty groups are simply not sent.
      // Still sent alongside a hand-capture: the photo is archived with
      // the quote even when the numbers came from the keyboard.
      meters.forEach((group, i) => {
        for (const file of group) body.append(`receipt_files_${i}`, file);
      });
      // Its presence is what tells the route to skip the vision call.
      if (manualMode) body.append('manual_reading', JSON.stringify(manual));

      const res = await fetch('/api/quotes/generate', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? 'No se pudo generar la cotización.');
        // A refusal now carries what the model read. Opening the card on
        // it turns a dead end into a correction: the numbers are right
        // there on the bill the user is holding.
        if (Array.isArray(data?.readings) && data.readings.length > 0) {
          setManual(data.readings as ManualMeterReading[]);
          setManualMode(true);
        }
        return;
      }
      setResult({
        downloadUrl: data.download_url,
        folio: data.folio,
        warning: data.warning ?? null,
      });
    } catch {
      setError('No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setGenerating(false);
    }
  }

  /** Switch between reading a bill and typing its numbers. */
  function setMode(manualNext: boolean) {
    setManualMode(manualNext);
    setError(null);
    setResult(null);
  }

  // Every group that exists must carry a bill. A meter added and left
  // empty is a mistake worth blocking, not an extra to ignore: the
  // quote it produces is short by one meter and looks perfectly normal.
  // The same rule holds for a hand-captured meter with no kWh in it.
  const filledMeters = meters.filter((g) => g.length > 0);
  const consumptionReady = manualMode
    ? manual.length > 0 && manual.every(hasConsumption)
    : filledMeters.length === meters.length && filledMeters.length > 0;
  const ready =
    clientName.trim() &&
    projectTypeId &&
    templateId &&
    consumptionReady &&
    !generating;

  if (loading) {
    return (
      <Card>
        <CardContent className="text-muted-foreground flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  // Both are prerequisites, and each has its own tab to fix it in.
  if (projectTypes.length === 0 || templates.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground text-sm">
            {templates.length === 0
              ? 'Primero sube una plantilla de propuesta.'
              : 'Primero crea un tipo de proyecto con sus rangos de precio.'}
          </p>
          <Button
            className="mt-4"
            onClick={templates.length === 0 ? onGoToTemplates : onGoToRules}
          >
            {templates.length === 0
              ? 'Ir a Plantillas'
              : 'Ir a Reglas de cálculo'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Generar cotización</CardTitle>
        <CardDescription className="text-muted-foreground">
          {manualMode
            ? 'Escribe el consumo del recibo tú mismo y el sistema llena la propuesta. Útil cuando la foto no se deja leer, o cuando el cliente solo te pasó los números.'
            : 'Escribe el nombre del cliente y elige el tipo de proyecto, adjunta su recibo CFE, y el sistema lee el consumo y llena la propuesta. El contacto es opcional y sirve para dejar la cotización ligada al CRM.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Two ways in, one form. "Sin recibo" is for the customer who
            reads their consumption over the phone, or the bill that no
            camera is going to render legible. */}
        <div className="border-border/80 bg-muted/40 inline-flex gap-1 rounded-lg border p-1">
          {[
            { manual: false, label: 'Con recibo' },
            { manual: true, label: 'Sin recibo' },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => setMode(option.manual)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                manualMode === option.manual
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-muted-foreground">
              Contacto{' '}
              <span className="text-muted-foreground/70">(opcional)</span>
            </Label>
            <Select
              items={contactItems}
              value={contactId}
              onValueChange={(v) => pickContact(v ?? '')}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Sin contacto" />
              </SelectTrigger>
              <SelectContent>
                {contactItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="quote-client-name"
              className="text-muted-foreground"
            >
              Nombre en la propuesta
            </Label>
            <Input
              id="quote-client-name"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Ej. Fernanda Díaz"
              maxLength={120}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Tipo de proyecto</Label>
            <Select
              items={projectTypeItems}
              value={projectTypeId}
              onValueChange={(v) => setProjectTypeId(v ?? '')}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Elige un tipo" />
              </SelectTrigger>
              <SelectContent>
                {projectTypeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Plantilla</Label>
            <Select
              items={templateItems}
              value={templateId}
              onValueChange={(v) => setTemplateId(v ?? '')}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Elige una plantilla" />
              </SelectTrigger>
              <SelectContent>
                {templateItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className={cn('space-y-3', manualMode && 'hidden')}>
          <Label className="text-muted-foreground">
            {meters.length > 1 ? 'Recibos CFE' : 'Recibo CFE'}
          </Label>

          {meters.map((group, meterIndex) => (
            <div key={meterIndex} className="space-y-2">
              {/* The per-meter heading only appears once there is more
                  than one, so the single-meter form stays as it was. */}
              {meters.length > 1 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium">
                    Medidor {meterIndex + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeMeter(meterIndex)}
                    className="text-muted-foreground hover:text-destructive rounded p-0.5 transition-colors"
                    aria-label={`Quitar medidor ${meterIndex + 1}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )}

              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRefs.current[meterIndex]?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ')
                    fileInputRefs.current[meterIndex]?.click();
                }}
                className={cn(
                  'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
                  group.length > 0
                    ? 'border-primary/35 bg-primary/[0.04]'
                    : 'border-border/80 bg-background/40 hover:border-primary/40 hover:bg-background/70'
                )}
              >
                <div
                  className={cn(
                    'flex size-10 items-center justify-center rounded-lg ring-1 transition-colors',
                    group.length > 0
                      ? 'bg-primary/15 ring-primary/25'
                      : 'bg-muted/80 ring-border/80 group-hover:bg-muted'
                  )}
                >
                  {group.length > 0 ? (
                    <FileText className="text-primary size-5" />
                  ) : (
                    <Upload className="text-muted-foreground group-hover:text-foreground size-5" />
                  )}
                </div>
                <p className="text-muted-foreground text-sm">
                  {group.length > 0
                    ? `${group.length} de ${MAX_RECEIPT_FILES} archivos`
                    : 'Haz clic para adjuntar el recibo'}
                </p>
                <p className="text-muted-foreground text-[11px]">
                  Foto o PDF. Incluye la página del historial de consumo para un
                  cálculo más preciso.
                </p>
              </div>

              <input
                ref={(el) => {
                  fileInputRefs.current[meterIndex] = el;
                }}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                multiple
                onChange={(e) => {
                  addFiles(meterIndex, e.target.files);
                  e.target.value = '';
                }}
                className="hidden"
              />

              {group.length > 0 && (
                <ul className="space-y-1">
                  {group.map((file, fileIndex) => (
                    <li
                      key={`${file.name}-${fileIndex}`}
                      className="bg-muted/50 text-muted-foreground flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                    >
                      <FileText className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {file.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFile(meterIndex, fileIndex)}
                        className="hover:bg-muted rounded p-0.5"
                        aria-label={`Quitar ${file.name}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          {meters.length < MAX_METERS && (
            <button
              type="button"
              onClick={() => setMeters((prev) => [...prev, []])}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
            >
              <Plus className="size-3.5" />
              Agregar otro medidor
            </button>
          )}

          {meters.length > 1 && (
            <p className="text-muted-foreground text-[11px]">
              El consumo de los {meters.length} medidores se suma para cotizar
              un solo sistema.
            </p>
          )}
        </div>

        {/* The error goes ABOVE the card it refers to: the card is what
            the user does about it, so the reason has to be read first. */}
        {error && (
          <div className="border-destructive/30 bg-destructive/5 text-destructive flex gap-2 rounded-lg border p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {manualMode && (
          <ManualReadingCard
            readings={manual}
            onChange={setManual}
            maxMeters={MAX_METERS}
            busy={generating}
          />
        )}

        <Button
          onClick={handleGenerate}
          disabled={!ready}
          className="w-full sm:w-auto"
        >
          {generating ? (
            <>
              <Loader2 className="mr-1.5 size-4 animate-spin" />
              {manualMode ? 'Generando…' : 'Leyendo el recibo…'}
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 size-4" />
              {manualMode ? 'Cotizar con estos datos' : 'Generar cotización'}
            </>
          )}
        </Button>

        {result && (
          <div className="border-border bg-muted/30 space-y-3 rounded-lg border p-4">
            <div className="text-foreground flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="text-primary size-4" />
              Cotización {result.folio} lista
            </div>
            {result.warning && (
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-500">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <p>{result.warning}</p>
              </div>
            )}
            <a
              href={result.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              <Download className="mr-1.5 size-4" />
              Descargar documento
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
