// A failed collection exits with one of these codes so the Hermes wrapper can
// say why without ever reading the collector's stderr. Node keeps 1-14 for
// its own failures and 128+ for signals; 1 stays "desconocido".
export const COLLECTOR_FAILURE_EXIT_CODES = Object.freeze({
  configuracion: 80,
  credenciales: 81,
  red: 82,
  respuesta: 83,
  datos: 84,
  timestamp_futuro: 85,
});

// Only the auditor's own fixed messages are matched; anything else is
// "desconocido". The message itself is never printed.
const CATEGORY_BY_MESSAGE = [
  ['timestamp_futuro', /timestamp futuro/],
  ['datos', /^El CRM (?:devolvió|excedió)|^CRM reference collision|^El snapshot coincidió/],
  [
    'credenciales',
    /credencial|principal de auditoría|origen de Supabase|origen configurado|CRM_AUDIT_SUPABASE_ORIGIN|cuenta configurada|cuenta distinta/,
  ],
  [
    'configuracion',
    /archivo de entorno|archivo dedicado|[Cc]onfiguración|clave no permitida|env -i|límites de salida|raíz del auditor|opciones (?:temporales|de límites)|ventana temporal|límites de lectura|CRM_AUDIT_ACCOUNT_ID|reference key|Invalid read options/,
  ],
  ['red', /deadline exceeded|timed out|aborted/],
  ['respuesta', /^Supabase /],
];

export function classifyCollectorFailure(error) {
  if (
    error instanceof Error &&
    typeof error.category === 'string' &&
    Object.hasOwn(COLLECTOR_FAILURE_EXIT_CODES, error.category)
  ) {
    return error.category;
  }
  const message = error instanceof Error ? error.message : '';
  for (const [category, pattern] of CATEGORY_BY_MESSAGE) {
    if (pattern.test(message)) return category;
  }
  return 'desconocido';
}

export function collectorFailureExitCode(category) {
  return Object.hasOwn(COLLECTOR_FAILURE_EXIT_CODES, category)
    ? COLLECTOR_FAILURE_EXIT_CODES[category]
    : 1;
}
