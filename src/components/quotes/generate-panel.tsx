'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Sparkles,
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

const MAX_RECEIPT_FILES = 3;

export function GeneratePanel({ onGoToRules, onGoToTemplates }: Props) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [projectTypes, setProjectTypes] = useState<QuoteProjectType[]>([]);
  const [templates, setTemplates] = useState<QuoteTemplate[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [projectTypeId, setProjectTypeId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [contactId, setContactId] = useState('');
  const [files, setFiles] = useState<File[]>([]);

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

  function addFiles(picked: FileList | null) {
    if (!picked) return;
    setFiles((prev) => [...prev, ...Array.from(picked)].slice(0, MAX_RECEIPT_FILES));
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      body.append('contact_id', contactId);
      body.append('project_type_id', projectTypeId);
      body.append('template_id', templateId);
      for (const file of files) body.append('receipt_files', file);

      const res = await fetch('/api/quotes/generate', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? 'No se pudo generar la cotización.');
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

  const ready =
    contactId && projectTypeId && templateId && files.length > 0 && !generating;

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-16 text-muted-foreground">
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
          <p className="text-sm text-muted-foreground">
            {templates.length === 0
              ? 'Primero sube una plantilla de propuesta.'
              : 'Primero crea un tipo de proyecto con sus rangos de precio.'}
          </p>
          <Button
            className="mt-4"
            onClick={templates.length === 0 ? onGoToTemplates : onGoToRules}
          >
            {templates.length === 0 ? 'Ir a Plantillas' : 'Ir a Reglas de cálculo'}
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
          Elige el cliente y el tipo de proyecto, adjunta su recibo CFE, y el
          sistema lee el consumo y llena la propuesta.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Cliente</Label>
            <Select
              value={contactId}
              onValueChange={(v) => setContactId(v ?? '')}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Elige un contacto" />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((contact) => (
                  <SelectItem key={contact.id} value={contact.id}>
                    {contact.name || contact.phone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Tipo de proyecto</Label>
            <Select
              value={projectTypeId}
              onValueChange={(v) => setProjectTypeId(v ?? '')}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Elige un tipo" />
              </SelectTrigger>
              <SelectContent>
                {projectTypes.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Plantilla</Label>
            <Select
              value={templateId}
              onValueChange={(v) => setTemplateId(v ?? '')}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Elige una plantilla" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-muted-foreground">Recibo CFE</Label>
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ')
                fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
              files.length > 0
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'border-border/80 bg-background/40 hover:border-primary/40 hover:bg-background/70',
            )}
          >
            <div
              className={cn(
                'flex size-10 items-center justify-center rounded-lg ring-1 transition-colors',
                files.length > 0
                  ? 'bg-primary/15 ring-primary/25'
                  : 'bg-muted/80 ring-border/80 group-hover:bg-muted',
              )}
            >
              {files.length > 0 ? (
                <FileText className="size-5 text-primary" />
              ) : (
                <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {files.length > 0
                ? `${files.length} de ${MAX_RECEIPT_FILES} archivos`
                : 'Haz clic para adjuntar el recibo'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Foto o PDF. Incluye la página del historial de consumo para un
              cálculo más preciso.
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            multiple
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
            className="hidden"
          />

          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((file, i) => (
                <li
                  key={`${file.name}-${i}`}
                  className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
                >
                  <FileText className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setFiles((prev) => prev.filter((_, j) => j !== i))
                    }
                    className="rounded p-0.5 hover:bg-muted"
                    aria-label={`Quitar ${file.name}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Button
          onClick={handleGenerate}
          disabled={!ready}
          className="w-full sm:w-auto"
        >
          {generating ? (
            <>
              <Loader2 className="mr-1.5 size-4 animate-spin" />
              Leyendo el recibo…
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 size-4" />
              Generar cotización
            </>
          )}
        </Button>

        {error && (
          <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {result && (
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CheckCircle2 className="size-4 text-primary" />
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
