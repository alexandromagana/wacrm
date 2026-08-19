'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
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
import type { QuoteProjectType } from '@/types';
import { ProjectTypeDialog } from './project-type-dialog';

/**
 * The account's project types and their price ladders.
 *
 * This is the tab that makes the whole feature worth building: today a
 * price lives in `SOLAR_TIERS` and changing it means a deploy.
 */
export function ProjectTypesPanel() {
  const canEdit = useCan('edit-settings');
  const [types, setTypes] = useState<QuoteProjectType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<QuoteProjectType | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchTypes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/quotes/project-types');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? 'Error');
      setTypes(data.projectTypes ?? []);
    } catch {
      toast.error('No se pudieron cargar los tipos de proyecto.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTypes();
  }, [fetchTypes]);

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/quotes/project-types/${id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? 'Error');
      toast.success('Tipo de proyecto eliminado.');
      setConfirmDelete(null);
      await fetchTypes();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'No se pudo eliminar.',
      );
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
              Tipos de proyecto
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Cada tipo tiene su propia tabla de precios y sus propios
              supuestos financieros. El cotizador usa el que elijas al
              generar.
            </CardDescription>
          </div>
          {canEdit && (
            <Button onClick={() => setCreating(true)} size="sm">
              <Plus className="mr-1.5 size-4" /> Nuevo tipo
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : types.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Todavía no hay tipos de proyecto.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {types.map((type) => {
              const tiers = type.quote_rate_tiers ?? [];
              const ceiling = tiers.length
                ? Number(tiers[tiers.length - 1].max_kwh)
                : 0;
              return (
                <li key={type.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {type.name}
                      </span>
                      {type.cfe_property_type_hint && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {type.cfe_property_type_hint}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {tiers.length === 0
                        ? 'Sin rangos de precio — no puede cotizar todavía'
                        : `${tiers.length} ${tiers.length === 1 ? 'rango' : 'rangos'} · hasta ${ceiling.toLocaleString('es-MX')} kWh bimestrales`}
                    </p>
                  </div>

                  {canEdit &&
                    (confirmDelete === type.id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          ¿Eliminar?
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busyId === type.id}
                          onClick={() => handleDelete(type.id)}
                        >
                          {busyId === type.id ? (
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
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(type)}
                          title="Editar"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(type.id)}
                          title="Eliminar"
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {(creating || editing) && (
        <ProjectTypeDialog
          projectType={editing}
          open
          onOpenChange={(open) => {
            if (!open) {
              setCreating(false);
              setEditing(null);
            }
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            fetchTypes();
          }}
        />
      )}
    </Card>
  );
}
