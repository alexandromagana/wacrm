import { describe, expect, it } from 'vitest';

import {
  COLLECTOR_FAILURE_EXIT_CODES,
  classifyCollectorFailure,
  collectorFailureExitCode,
} from './collector-failure.mjs';

const classify = (message: string) =>
  classifyCollectorFailure(new Error(message));

describe('classifyCollectorFailure', () => {
  it.each([
    ['El CRM devolvió un timestamp futuro; cobertura desconocida.', 'timestamp_futuro'],
    ['El CRM devolvió un estado inválido; cobertura desconocida.', 'datos'],
    ['El CRM devolvió relaciones inválidas; cobertura desconocida.', 'datos'],
    ['El CRM excedió límites de entrada; cobertura desconocida.', 'datos'],
    ['CRM reference collision; coverage unknown.', 'datos'],
    ['El snapshot coincidió con una credencial sensible y fue bloqueado.', 'datos'],
    ['Las credenciales de Supabase no pertenecen al principal de auditoría.', 'credenciales'],
    ['La cuenta o vigencia de la credencial es inválida.', 'credenciales'],
    ['El origen de Supabase no coincide con el origen fijado.', 'credenciales'],
    ['Supabase no confirmó exactamente la cuenta configurada; cobertura desconocida.', 'credenciales'],
    ['Supabase devolvió una cuenta distinta o inválida; cobertura desconocida.', 'credenciales'],
    ['El archivo de entorno del auditor no es confiable.', 'configuracion'],
    ['Falta el archivo dedicado de configuración del auditor.', 'configuracion'],
    ['Entorno de ejecución no confiable; inicie con env -i.', 'configuracion'],
    ['La configuración no garantiza cobertura y solapamiento.', 'configuracion'],
    ['Los límites de lectura de Supabase son inválidos.', 'configuracion'],
    ['Define CRM_AUDIT_ACCOUNT_ID como UUID para limitar la auditoría a una sola cuenta.', 'configuracion'],
    ['Supabase request failed: total deadline exceeded', 'red'],
    ['Supabase read aborted.', 'red'],
    ['Supabase devolvió un Content-Range inconsistente; cobertura desconocida.', 'respuesta'],
    ['Supabase excedió el límite seguro de filas para "crm_audit_messages".', 'respuesta'],
  ])('files %j under %s', (message, category) => {
    expect(classify(message)).toBe(category);
  });

  it('trusts the category set where the failure happened', () => {
    const failure = Object.assign(
      new Error('Supabase request failed for allowlisted table "crm_audit_messages".'),
      { category: 'red' }
    );
    expect(classifyCollectorFailure(failure)).toBe('red');
  });

  it('ignores a category outside the closed set', () => {
    const failure = Object.assign(new Error('anything'), { category: 'shell' });
    expect(classifyCollectorFailure(failure)).toBe('desconocido');
  });

  it('calls anything else unknown instead of guessing', () => {
    expect(classify('Unexpected token < in JSON at position 0')).toBe('desconocido');
    expect(classifyCollectorFailure('not an error')).toBe('desconocido');
    expect(classifyCollectorFailure(undefined)).toBe('desconocido');
  });
});

describe('collectorFailureExitCode', () => {
  it('gives each category its own code outside what Node and signals use', () => {
    const codes = Object.values(COLLECTOR_FAILURE_EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toBeGreaterThan(14);
      expect(code).toBeLessThan(128);
    }
  });

  it('exits with 1 when the cause is unknown', () => {
    expect(collectorFailureExitCode('desconocido')).toBe(1);
    expect(collectorFailureExitCode('__proto__')).toBe(1);
  });
});
