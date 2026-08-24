'use client';

import { Plus, Trash2, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  emptyManualReading,
  hasConsumption,
  MAX_HISTORIAL_BIMESTRES,
  type ManualMeterReading,
} from '@/lib/quotes/reading';

interface Props {
  readings: ManualMeterReading[];
  onChange: (readings: ManualMeterReading[]) => void;
  /** Meters the parent form allows, so the two ceilings stay in step. */
  maxMeters: number;
  /** Whether the parent is mid-request, to freeze the inputs. */
  busy?: boolean;
}

/**
 * A field that holds "" while being typed and reports null when empty.
 * Kept as text rather than `type="number"` state so a half-typed value
 * ("1,6") does not collapse to null and yank the caret.
 */
function numberText(value: number | null): string {
  return value == null ? '' : String(value);
}

function parseField(raw: string): number | null {
  const cleaned = raw.replace(/[\s,$]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The average, exactly as the server will compute it — same window, same
 * rounding as `buildExtraction`. Shown live so the user can see which
 * price band the numbers land in BEFORE spending a generation on them.
 */
function previewAverage(reading: ManualMeterReading): {
  average: number | null;
  periods: number;
} {
  const values = [
    reading.consumo_periodo_actual_kwh,
    ...reading.historial_bimestres_kwh,
  ].filter((v): v is number => v != null);
  if (values.length === 0) return { average: null, periods: 0 };
  return {
    average: Math.round(values.reduce((sum, v) => sum + v, 0) / values.length),
    periods: values.length,
  };
}

/**
 * The numbers off a CFE bill, editable by hand.
 *
 * Reached two ways, both landing on this same component: as a
 * correction card pre-filled with whatever the vision model did read
 * when a quote was refused, and as the whole input in "Sin recibo"
 * mode. A photographed bill that arrives cropped, sideways, or as two
 * fragments is the normal case, not the exception — before this existed
 * a read the model got wrong had no way forward at all.
 */
export function ManualReadingCard({
  readings,
  onChange,
  maxMeters,
  busy,
}: Props) {
  function update(index: number, patch: Partial<ManualMeterReading>) {
    onChange(readings.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  /**
   * Set one history slot, keeping the row even when it is emptied. The
   * blank stays on screen so the caret does not jump and the fields
   * after it do not shift up mid-edit; it is dropped on the way to the
   * server, never averaged as a zero.
   */
  function setHistorial(index: number, slot: number, value: number | null) {
    const next = [...readings[index].historial_bimestres_kwh];
    next[slot] = value;
    update(index, { historial_bimestres_kwh: next });
  }

  function removeHistorial(index: number, slot: number) {
    update(index, {
      historial_bimestres_kwh: readings[index].historial_bimestres_kwh.filter(
        (_, i) => i !== slot
      ),
    });
  }

  const totalKwh = readings.reduce(
    (sum, r) => sum + (previewAverage(r).average ?? 0),
    0
  );

  return (
    <div className="border-border bg-muted/20 space-y-4 rounded-lg border p-4">
      <div>
        <p className="text-foreground text-sm font-medium">
          Datos del recibo
        </p>
        <p className="text-muted-foreground text-[11px]">
          Escribe los kWh tal como vienen en el recibo. Con el bimestre
          actual y el historial se calcula el promedio; entre más periodos,
          más preciso.
        </p>
      </div>

      {readings.map((reading, index) => {
        const { average, periods } = previewAverage(reading);
        return (
          <div
            key={index}
            className="border-border/60 space-y-3 rounded-md border p-3"
          >
            {readings.length > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs font-medium">
                  Medidor {index + 1}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onChange(readings.filter((_, i) => i !== index))
                  }
                  className="text-muted-foreground hover:text-destructive rounded p-0.5 transition-colors"
                  aria-label={`Quitar medidor ${index + 1}`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}

            <div className="space-y-1.5">
              <Label
                htmlFor={`consumo-${index}`}
                className="text-muted-foreground text-xs"
              >
                Consumo del bimestre actual (kWh)
              </Label>
              <Input
                id={`consumo-${index}`}
                inputMode="decimal"
                disabled={busy}
                placeholder="Ej. 1611"
                value={numberText(reading.consumo_periodo_actual_kwh)}
                onChange={(e) =>
                  update(index, {
                    consumo_periodo_actual_kwh: parseField(e.target.value),
                  })
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                Historial de consumo (kWh) hasta{' '}
                {MAX_HISTORIAL_BIMESTRES} bimestres, del más reciente al
                más antiguo
              </Label>
              <div className="flex flex-wrap gap-2">
                {reading.historial_bimestres_kwh.map((value, slot) => (
                  <div key={slot} className="relative">
                    <Input
                      inputMode="decimal"
                      disabled={busy}
                      placeholder="kWh"
                      value={numberText(value)}
                      onChange={(e) =>
                        setHistorial(index, slot, parseField(e.target.value))
                      }
                      className="w-24 pr-7"
                      aria-label={`Bimestre ${slot + 1}`}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => removeHistorial(index, slot)}
                      className="text-muted-foreground hover:text-destructive absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5"
                      aria-label={`Quitar bimestre ${slot + 1}`}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
                {reading.historial_bimestres_kwh.length <
                  MAX_HISTORIAL_BIMESTRES && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      update(index, {
                        historial_bimestres_kwh: [
                          ...reading.historial_bimestres_kwh,
                          null,
                        ],
                      })
                    }
                    className="text-muted-foreground hover:text-foreground border-border/80 hover:border-primary/40 flex h-9 w-24 items-center justify-center gap-1 rounded-md border border-dashed text-xs transition-colors"
                  >
                    <Plus className="size-3.5" />
                    Bimestre
                  </button>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label
                  htmlFor={`importe-${index}`}
                  className="text-muted-foreground text-xs"
                >
                  Fac. del periodo (MXN)
                </Label>
                <Input
                  id={`importe-${index}`}
                  inputMode="decimal"
                  disabled={busy}
                  placeholder="Ej. 3634.31"
                  value={numberText(reading.importe_periodo_mxn)}
                  onChange={(e) =>
                    update(index, {
                      importe_periodo_mxn: parseField(e.target.value),
                    })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor={`dap-${index}`}
                  className="text-muted-foreground text-xs"
                >
                  DAP (MXN)
                </Label>
                <Input
                  id={`dap-${index}`}
                  inputMode="decimal"
                  disabled={busy}
                  placeholder="Ej. 156.65"
                  value={numberText(reading.importe_dap_mxn)}
                  onChange={(e) =>
                    update(index, {
                      importe_dap_mxn: parseField(e.target.value),
                    })
                  }
                />
              </div>
            </div>

            {/* Not the TOTAL A PAGAR: that one carries debt and credit
                from earlier bimesters, and the 25-year projection would
                multiply the error. Said here so nobody types it in. */}
            <p className="text-muted-foreground text-[11px]">
              Del bloque &ldquo;Desglose del importe a pagar&rdquo;. No uses el
              TOTAL A PAGAR, ese trae adeudos de bimestres anteriores y
              deforma la proyección de ahorro.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label
                  htmlFor={`tarifa-${index}`}
                  className="text-muted-foreground text-xs"
                >
                  Tarifa <span className="opacity-70">(opcional)</span>
                </Label>
                <Input
                  id={`tarifa-${index}`}
                  disabled={busy}
                  placeholder="Ej. 1D"
                  value={reading.tarifa ?? ''}
                  onChange={(e) =>
                    update(index, { tarifa: e.target.value || null })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor={`ciudad-${index}`}
                  className="text-muted-foreground text-xs"
                >
                  Ciudad <span className="opacity-70">(opcional)</span>
                </Label>
                <Input
                  id={`ciudad-${index}`}
                  disabled={busy}
                  placeholder="Ej. Cancún"
                  value={reading.ciudad ?? ''}
                  onChange={(e) =>
                    update(index, { ciudad: e.target.value || null })
                  }
                />
              </div>
            </div>

            {hasConsumption(reading) && average != null && (
              <p className="text-muted-foreground text-xs">
                Promedio bimestral:{' '}
                <span className="text-foreground font-medium">
                  {average.toLocaleString('es-MX')} kWh
                </span>{' '}
                sobre {periods} {periods === 1 ? 'periodo' : 'periodos'}
                {periods < 2 && (
                  <span className="text-amber-700 dark:text-amber-500">
                    {' '}
                    hacen falta al menos 2
                  </span>
                )}
              </p>
            )}
          </div>
        );
      })}

      {readings.length < maxMeters && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange([...readings, emptyManualReading()])}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
        >
          <Plus className="size-3.5" />
          Agregar otro medidor
        </button>
      )}

      {readings.length > 1 && totalKwh > 0 && (
        <p className="text-muted-foreground text-[11px]">
          Los {readings.length} medidores suman{' '}
          <span className="text-foreground font-medium">
            {totalKwh.toLocaleString('es-MX')} kWh
          </span>{' '}
          bimestrales y se cotizan como un solo sistema.
        </p>
      )}
    </div>
  );
}
