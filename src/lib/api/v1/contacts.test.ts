import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  parseCustomFieldsInput,
  selectTagIds,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      custom_fields: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
    expect(serializeContact(row).custom_fields).toEqual({});
  });

  it('flattens custom values into a name→value map, skipping orphans and nulls', () => {
    const row = {
      id: 'c3',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
      contact_custom_values: [
        { value: 'Cancún', custom_fields: { field_name: 'Ciudad' } },
        {
          value: 'Si',
          custom_fields: { field_name: 'Interesado en financiamiento' },
        },
        { value: 'x', custom_fields: null }, // field deleted — dropped
        { value: null, custom_fields: { field_name: 'Tamaño de techo' } }, // unset
      ],
    };
    expect(serializeContact(row).custom_fields).toEqual({
      Ciudad: 'Cancún',
      'Interesado en financiamiento': 'Si',
    });
  });
});

describe('parseCustomFieldsInput', () => {
  it('returns empty for a missing value', () => {
    expect(parseCustomFieldsInput(undefined)).toEqual({
      customs: [],
      contactPatch: {},
    });
    expect(parseCustomFieldsInput(null).customs).toEqual([]);
  });

  it('canonicalizes known lead-form questions onto the shared field names', () => {
    const { customs } = parseCustomFieldsInput({
      '¿Estás interesada/o en opciones de financiamiento?': 'Si',
      City: 'Mexico City',
      '¿Cuál e el tamaño aproximado de tu techo?': '40 m2',
    });
    expect(customs).toEqual(
      expect.arrayContaining([
        { fieldName: 'Interesado en financiamiento', value: 'Si' },
        { fieldName: 'Ciudad', value: 'Mexico City' },
        { fieldName: 'Tamaño de techo', value: '40 m2' },
      ])
    );
    expect(customs).toHaveLength(3);
  });

  it('routes a name/email question to the contact row, and drops phone', () => {
    const { customs, contactPatch } = parseCustomFieldsInput({
      'Full name': 'Ada Lovelace',
      Email: 'ada@example.com',
      'Phone number': '+525511481242',
    });
    expect(contactPatch).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(customs).toEqual([]);
  });

  it('keeps an unknown question as a field named after it', () => {
    expect(
      parseCustomFieldsInput({ '¿Cuántos focos tienes?': '12' }).customs
    ).toEqual([{ fieldName: 'Cuántos focos tienes', value: '12' }]);
  });

  it('joins an array answer (multi-select) and stringifies scalars', () => {
    const { customs } = parseCustomFieldsInput({
      Intereses: ['Paneles', 'Baterías'],
      Presupuesto: 15000,
      Contactado: false,
    });
    expect(customs).toEqual(
      expect.arrayContaining([
        { fieldName: 'Intereses', value: 'Paneles, Baterías' },
        { fieldName: 'Presupuesto', value: '15000' },
        { fieldName: 'Contactado', value: 'false' },
      ])
    );
  });

  it('drops empty answers rather than blanking an existing value', () => {
    const { customs, contactPatch } = parseCustomFieldsInput({
      Ciudad: '   ',
      Notas: null,
      Otros: [],
      'Full name': '',
    });
    expect(customs).toEqual([]);
    expect(contactPatch).toEqual({});
  });

  it('collapses two questions that canonicalize to the same field', () => {
    const { customs } = parseCustomFieldsInput({
      City: 'Cancún',
      Ciudad: 'Mérida',
    });
    expect(customs).toEqual([{ fieldName: 'Ciudad', value: 'Mérida' }]);
  });

  it('rejects a non-object, an object-valued answer, and too many entries', () => {
    expect(() => parseCustomFieldsInput('nope')).toThrow(ContactError);
    expect(() => parseCustomFieldsInput([1, 2])).toThrow(ContactError);
    expect(() => parseCustomFieldsInput({ Ciudad: { a: 1 } })).toThrow(
      ContactError
    );

    const tooMany = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`Campo ${i}`, 'x'])
    );
    expect(() => parseCustomFieldsInput(tooMany)).toThrow(ContactError);
  });

  it('reports a 400 status on bad input', () => {
    expect(() => parseCustomFieldsInput('nope')).toThrow(
      expect.objectContaining({ status: 400 })
    );
  });
});

describe('selectTagIds', () => {
  // `resolveImportTagIds` returns a lookup over EVERY tag in the
  // account, so the map always carries names this request never asked
  // for. Reading its `.values()` tagged the contact with all of them.
  const accountTags = new Map([
    ['cold lead', 't-cold'],
    ['warm lead', 't-warm'],
    ['hot lead', 't-hot'],
    ['facebook ads', 't-fb'],
    ['quote sent', 't-quote'],
  ]);

  it('selects only the requested names, not the whole account map', () => {
    expect(selectTagIds(['Facebook Ads'], accountTags)).toEqual(
      new Set(['t-fb'])
    );
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(selectTagIds(['  FACEBOOK ads '], accountTags)).toEqual(
      new Set(['t-fb'])
    );
  });

  it('de-duplicates names that resolve to the same tag', () => {
    expect(selectTagIds(['Facebook Ads', 'facebook ads'], accountTags)).toEqual(
      new Set(['t-fb'])
    );
  });

  it('skips a name with no matching tag', () => {
    expect(selectTagIds(['Facebook Ads', 'nope'], accountTags)).toEqual(
      new Set(['t-fb'])
    );
  });

  it('returns an empty set for no names — the "clear all tags" case', () => {
    expect(selectTagIds([], accountTags)).toEqual(new Set());
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });
});
