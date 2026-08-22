import { describe, it, expect } from 'vitest';
import { addFilesToMeter } from './meter-files';

function file(name: string): File {
  return new File(['x'], name, { type: 'application/pdf' });
}

/**
 * Stand-in for an `<input type="file">`'s `files`: array-like, and — the
 * part that matters — emptied out from under whoever is holding it, the
 * way the browser empties it when the change handler resets
 * `input.value`.
 */
function livePickerList(...files: File[]) {
  const list: { length: number; [i: number]: File } = { length: files.length };
  files.forEach((f, i) => (list[i] = f));
  return {
    list: list as ArrayLike<File>,
    /** What `input.value = ''` does to the list already handed out. */
    clear: () => (list.length = 0),
  };
}

describe('addFilesToMeter', () => {
  it('keeps the picked file when the input is cleared before React runs the updater', () => {
    // The reported bug: pick a bill, and it never shows up in the list.
    // The handler resets the input so the same file can be picked again,
    // and an updater that read the FileList itself would find it empty
    // by the time React got around to running it.
    const picker = livePickerList(file('medidor-dos.pdf'));
    const update = addFilesToMeter(1, picker.list, 3);

    picker.clear();

    const next = update([[file('medidor-uno.pdf')], []]);
    expect(next[1].map((f) => f.name)).toEqual(['medidor-dos.pdf']);
  });

  it('adds to the meter picked and leaves the others alone', () => {
    const picker = livePickerList(file('b.pdf'));
    const next = addFilesToMeter(1, picker.list, 3)([[file('a.pdf')], []]);
    expect(next[0].map((f) => f.name)).toEqual(['a.pdf']);
    expect(next[1].map((f) => f.name)).toEqual(['b.pdf']);
  });

  it('appends to a meter that already has a page', () => {
    const picker = livePickerList(file('pagina-2.jpg'));
    const next = addFilesToMeter(0, picker.list, 3)([[file('pagina-1.jpg')]]);
    expect(next[0].map((f) => f.name)).toEqual(['pagina-1.jpg', 'pagina-2.jpg']);
  });

  it('takes several files from one pick', () => {
    const picker = livePickerList(file('p1.jpg'), file('p2.jpg'));
    const next = addFilesToMeter(0, picker.list, 3)([[]]);
    expect(next[0]).toHaveLength(2);
  });

  it('caps a meter at its file limit', () => {
    const picker = livePickerList(file('c.jpg'), file('d.jpg'));
    const next = addFilesToMeter(0, picker.list, 3)([
      [file('a.jpg'), file('b.jpg')],
    ]);
    expect(next[0].map((f) => f.name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('changes nothing when the pick was cancelled', () => {
    const before: File[][] = [[file('a.pdf')], []];
    const next = addFilesToMeter(1, null, 3)(before);
    expect(next[0].map((f) => f.name)).toEqual(['a.pdf']);
    expect(next[1]).toEqual([]);
  });
});
