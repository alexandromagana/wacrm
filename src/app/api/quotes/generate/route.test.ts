import { describe, it, expect } from 'vitest';
import { readMeterGroups } from './route';

/**
 * The form contract between the Cotizador panel and this route: bills
 * grouped by meter under `receipt_files_<n>`. Worth guarding on its own
 * because a mismatch here fails silently in the worst possible
 * direction — the quote still generates, just for fewer meters than the
 * customer has.
 */
function file(name: string): File {
  return new File(['x'], name, { type: 'application/pdf' });
}

describe('readMeterGroups', () => {
  it('reads one group per meter, in order', () => {
    const form = new FormData();
    form.append('receipt_files_0', file('medidor-a.pdf'));
    form.append('receipt_files_1', file('medidor-b.pdf'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(2);
    expect(groups[0][0].name).toBe('medidor-a.pdf');
    expect(groups[1][0].name).toBe('medidor-b.pdf');
  });

  it('keeps a meter’s pages together in its own group', () => {
    const form = new FormData();
    form.append('receipt_files_0', file('pagina-1.jpg'));
    form.append('receipt_files_0', file('pagina-2.jpg'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('closes the gap when a middle meter was removed in the UI', () => {
    // React keys by index, so removing meter 2 of 3 can post 0 and 2.
    // Treating that as three meters would send an empty group into the
    // vision call and fail a quote that is perfectly complete.
    const form = new FormData();
    form.append('receipt_files_0', file('a.pdf'));
    form.append('receipt_files_2', file('c.pdf'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(2);
    expect(groups[1][0].name).toBe('c.pdf');
  });

  it('caps the files inside one meter', () => {
    const form = new FormData();
    for (let i = 0; i < 6; i++) {
      form.append('receipt_files_0', file(`p${i}.jpg`));
    }
    expect(readMeterGroups(form)[0]).toHaveLength(3);
  });

  it('caps how many meters one quote covers', () => {
    const form = new FormData();
    for (let i = 0; i < 8; i++) {
      form.append(`receipt_files_${i}`, file(`m${i}.pdf`));
    }
    expect(readMeterGroups(form)).toHaveLength(4);
  });

  it('reads the flat field as a single meter', () => {
    // What the panel posted before meters existed.
    const form = new FormData();
    form.append('receipt_files', file('recibo.pdf'));
    form.append('receipt_files', file('recibo-p2.pdf'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('prefers the grouped fields when both are present', () => {
    const form = new FormData();
    form.append('receipt_files', file('viejo.pdf'));
    form.append('receipt_files_0', file('nuevo.pdf'));

    const groups = readMeterGroups(form);
    expect(groups).toHaveLength(1);
    expect(groups[0][0].name).toBe('nuevo.pdf');
  });

  it('reports nothing when no bill was attached', () => {
    expect(readMeterGroups(new FormData())).toEqual([]);
  });

  it('ignores non-file values posted under the field name', () => {
    const form = new FormData();
    form.append('receipt_files_0', 'not-a-file');
    expect(readMeterGroups(form)).toEqual([]);
  });
});
