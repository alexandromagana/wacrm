'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useCan } from '@/hooks/use-can';
import { QUOTE_MERGE_TAGS } from '@/lib/quotes/merge-fields';
import type { QuoteTemplate } from '@/types';
import { TemplateUploadDialog } from './template-upload-dialog';

const KNOWN_TAGS = new Set<string>(QUOTE_MERGE_TAGS);

export function TemplatesPanel() {
  const canEdit = useCan('edit-settings');
  const [templates, setTemplates] = useState<QuoteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/quotes/templates');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? 'Error');
      setTemplates(data.templates ?? []);
    } catch {
      toast.error('No se pudieron cargar las plantillas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTemplates();
  }, [fetchTemplates]);

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/quotes/templates/${id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? 'Error');
      toast.success('Plantilla eliminada.');
      setConfirmDelete(null);
      await fetchTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo eliminar.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-foreground">
              Plantillas de propuesta
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Documentos de Word o PowerPoint con marcadores{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                {'{{nombre}}'}
              </code>{' '}
              que el cotizador rellena solo.
            </CardDescription>
          </div>
          {canEdit && (
            <Button onClick={() => setUploading(true)} size="sm">
              <Upload className="mr-1.5 size-4" /> Subir plantilla
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : templates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Todavía no hay plantillas. Sube tu propuesta editable para
            empezar.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {templates.map((template) => {
              const unknown = template.detected_tags.filter(
                (t) => !KNOWN_TAGS.has(t),
              );
              return (
                <li
                  key={template.id}
                  className="flex flex-wrap items-center gap-3 py-3"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <FileText className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {template.name}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium uppercase text-muted-foreground">
                        {template.file_type}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {template.detected_tags.length} marcadores
                      {unknown.length > 0 && (
                        <span className="text-amber-600 dark:text-amber-500">
                          {' '}
                          · {unknown.length} sin datos: {unknown.join(', ')}
                        </span>
                      )}
                    </p>
                  </div>

                  {canEdit &&
                    (confirmDelete === template.id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          ¿Eliminar?
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busyId === template.id}
                          onClick={() => handleDelete(template.id)}
                        >
                          {busyId === template.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            'Sí'
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(null)}
                        >
                          No
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDelete(template.id)}
                        title="Eliminar"
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {uploading && (
        <TemplateUploadDialog
          open
          onOpenChange={setUploading}
          onUploaded={() => {
            setUploading(false);
            fetchTemplates();
          }}
        />
      )}
    </Card>
  );
}
