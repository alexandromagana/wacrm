'use client';

import { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { validateTierTable, type TierInput } from '@/lib/quotes/tier-validation';
import type { QuoteProjectType } from '@/types';

interface Props {
  /** Null when creating. */
  projectType: QuoteProjectType | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const NO_HINT = 'ninguno';

/** Blank row for a fresh type — the shape, not a suggested price. */
const EMPTY_TIER: TierInput = {
  minKwh: 0,
  maxKwh: 0,
  panels: 0,
  systemKw: 0,
  priceMxn: 0,
};

/**
 * Percentages are stored as decimals (0.035) but read and typed as
 * percentages (3.5) — asking a business owner to enter "0.035" for
 * 3.5% invites an order-of-magnitude typo on a number that compounds
 * across 25 years.
 */
const toPercent = (v: number) => String(Math.round(v * 1000) / 10);
const fromPercent = (v: string) => Number(v) / 100;

export function ProjectTypeDialog({
  projectType,
  open,
  onOpenChange,
  onSaved,
}: Props) {
  const editing = projectType !== null;

  const [name, setName] = useState(projectType?.name ?? '');
  const [hint, setHint] = useState<string>(
    projectType?.cfe_property_type_hint ?? NO_HINT,
  );
  const [inflation, setInflation] = useState(
    toPercent(Number(projectType?.annual_inflation ?? 0.035)),
  );
  const [fixedCharge, setFixedCharge] = useState(
    String(Number(projectType?.fixed_charge_bimonthly_mxn ?? 65)),
  );
  const [sunHours, setSunHours] = useState(
    String(Number(projectType?.peak_sun_hours ?? 5)),
  );
  const [efficiency, setEfficiency] = useState(
    toPercent(Number(projectType?.system_efficiency ?? 0.85)),
  );
  const [horizon, setHorizon] = useState(
    String(Number(projectType?.horizon_years ?? 25)),
  );
  const [tiers, setTiers] = useState<TierInput[]>(() =>
    projectType?.quote_rate_tiers?.length
      ? projectType.quote_rate_tiers.map((t) => ({
          minKwh: Number(t.min_kwh),
          maxKwh: Number(t.max_kwh),
          panels: Number(t.panels),
          systemKw: Number(t.system_kw),
          priceMxn: Number(t.price_mxn),
        }))
      : [{ ...EMPTY_TIER }],
  );
  const [saving, setSaving] = useState(false);

  const tierErrors = validateTierTable(tiers);
  const canSave = name.trim().length > 0 && tierErrors.length === 0 && !saving;

  function updateTier(index: number, patch: Partial<TierInput>) {
    setTiers((prev) =>
      prev.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(
        editing
          ? `/api/quotes/project-types/${projectType.id}`
          : '/api/quotes/project-types',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            cfe_property_type_hint: hint === NO_HINT ? null : hint,
            annual_inflation: fromPercent(inflation),
            fixed_charge_bimonthly_mxn: Number(fixedCharge),
            peak_sun_hours: Number(sunHours),
            system_efficiency: fromPercent(efficiency),
            horizon_years: Number(horizon),
            tiers,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? 'No se pudo guardar.');
      toast.success(editing ? 'Tipo de proyecto actualizado.' : 'Tipo de proyecto creado.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {editing ? `Editar ${projectType.name}` : 'Nuevo tipo de proyecto'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Define los rangos de consumo con su precio, y los supuestos con
            los que se calcula el ahorro a futuro.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Nombre</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Comercial PDBT"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                Tarifa CFE esperada
              </Label>
              <Select
                value={hint}
                onValueChange={(v) => setHint(v ?? NO_HINT)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_HINT}>Sin verificación</SelectItem>
                  <SelectItem value="Casa">Casa (1, 1A–1F, DAC)</SelectItem>
                  <SelectItem value="Negocio">Negocio (PDBT)</SelectItem>
                  <SelectItem value="Industria">Industria (GD…)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Si el recibo trae otra tarifa, el cotizador avisa pero no
                bloquea.
              </p>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-muted-foreground">
                Rangos de consumo y precio
              </Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setTiers((prev) => [...prev, { ...EMPTY_TIER }])}
              >
                <Plus className="mr-1 size-4" /> Agregar rango
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="pb-1 pr-2 font-medium">kWh desde</th>
                    <th className="pb-1 pr-2 font-medium">kWh hasta</th>
                    <th className="pb-1 pr-2 font-medium">Paneles</th>
                    <th className="pb-1 pr-2 font-medium">Sistema (kW)</th>
                    <th className="pb-1 pr-2 font-medium">Precio (MXN)</th>
                    <th className="pb-1" />
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tier, i) => (
                    <tr key={i}>
                      {(
                        [
                          ['minKwh', '1'],
                          ['maxKwh', '1'],
                          ['panels', '1'],
                          ['systemKw', '0.01'],
                          ['priceMxn', '1'],
                        ] as const
                      ).map(([field, step]) => (
                        <td key={field} className="py-1 pr-2">
                          <Input
                            type="number"
                            step={step}
                            value={String(tier[field])}
                            onChange={(e) =>
                              updateTier(i, { [field]: Number(e.target.value) })
                            }
                            className="h-8"
                          />
                        </td>
                      ))}
                      <td className="py-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={tiers.length === 1}
                          onClick={() =>
                            setTiers((prev) => prev.filter((_, j) => j !== i))
                          }
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {tierErrors.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-destructive">
                {tierErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <Label className="text-muted-foreground">
              Supuestos de la proyección
            </Label>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Con esto se calcula el ahorro a {horizon || '25'} años y en
              cuánto se paga solo el sistema.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ['Inflación anual (%)', inflation, setInflation, '0.1'],
                  ['Cargo fijo bimestral (MXN)', fixedCharge, setFixedCharge, '1'],
                  ['Horas sol pico', sunHours, setSunHours, '0.1'],
                  ['Eficiencia del sistema (%)', efficiency, setEfficiency, '1'],
                  ['Horizonte (años)', horizon, setHorizon, '1'],
                ] as const
              ).map(([label, value, setter, step]) => (
                <div key={label} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {label}
                  </Label>
                  <Input
                    type="number"
                    step={step}
                    value={value}
                    onChange={(e) => setter(e.target.value)}
                    className="h-8"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!canSave} onClick={handleSave}>
            {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
