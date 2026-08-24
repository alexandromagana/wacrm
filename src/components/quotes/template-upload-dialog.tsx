'use client';

import { useRef, useState } from 'react';
import { FileText, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { QUOTE_MERGE_TAGS } from '@/lib/quotes/merge-fields';
import { TEMPLATE_ACCEPT, TEMPLATE_MAX_BYTES } from '@/lib/quotes/templates';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

export function TemplateUploadDialog({ open, onOpenChange, onUploaded }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);

  function handlePick(picked: File | undefined) {
    if (!picked) return;
    if (picked.size > TEMPLATE_MAX_BYTES) {
      toast.error('El archivo supera el límite de 25 MB.');
      return;
    }
    setFile(picked);
    if (!name) setName(picked.name.replace(/\.[^.]+$/, ''));
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('name', name.trim() || file.name);
      const res = await fetch('/api/quotes/templates', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? 'No se pudo subir.');

      const tags: string[] = data.template?.detected_tags ?? [];
      const known = new Set<string>(QUOTE_MERGE_TAGS);
      const unknown = tags.filter((t) => !known.has(t));
      if (unknown.length > 0) {
        toast.warning(
          `Plantilla subida. ${unknown.length} marcador(es) quedarán en blanco porque el cotizador no tiene ese dato: ${unknown.join(', ')}`,
        );
      } else {
        toast.success(`Plantilla subida: ${tags.length} marcadores listos.`);
      }
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Subir plantilla
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Un archivo .docx o .pptx donde cada dato de la cotización esté
            escrito entre dobles llaves.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'border-border/80 bg-background/40 hover:border-primary/40 hover:bg-background/70',
            )}
          >
            {file ? (
              <>
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/25">
                  <FileText className="size-5 text-primary" />
                </div>
                <p
                  className="max-w-full truncate px-2 text-sm font-medium text-popover-foreground"
                  title={file.name}
                >
                  {file.name}
                </p>
              </>
            ) : (
              <>
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
                  <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Haz clic para elegir el archivo
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Word (.docx) o PowerPoint (.pptx), hasta 25 MB
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={TEMPLATE_ACCEPT}
            onChange={(e) => handlePick(e.target.files?.[0])}
            className="hidden"
          />

          <div className="space-y-2">
            <Label className="text-muted-foreground">Nombre</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej. Propuesta residencial"
            />
          </div>

          <details className="rounded-lg border border-border/70 bg-muted/30 p-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Marcadores disponibles ({QUOTE_MERGE_TAGS.length})
            </summary>
            <div className="mt-2 flex flex-wrap gap-1">
              {QUOTE_MERGE_TAGS.map((tag) => (
                <code
                  key={tag}
                  className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {`{{${tag}}}`}
                </code>
              ))}
            </div>
          </details>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!file || uploading} onClick={handleUpload}>
            {uploading && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Subir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
