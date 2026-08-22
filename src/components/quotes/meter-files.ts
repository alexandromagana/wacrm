/**
 * Adding picked files to one meter's group.
 *
 * Lives apart from the panel for one reason: the bug it exists to
 * prevent is about *when* the picked files are read, and that is only
 * testable if the updater can be built in one step and run in another.
 */

/**
 * Build the `setMeters` updater that appends `picked` to one meter.
 *
 * `picked` is read RIGHT HERE, before the updater is returned. That is
 * the whole point of this function. A file input's `files` is a live
 * FileList owned by the element, and every one of these handlers resets
 * `input.value` immediately after picking so the same file can be
 * chosen twice in a row — which empties that list. React is free to run
 * a state updater after the handler returns, so an updater that reads
 * the list itself finds it empty and drops the file with no error
 * anywhere: the picker closes, and nothing appears.
 *
 * Takes `ArrayLike<File>` rather than `FileList` so a test can hand it
 * an array-like and then empty it, reproducing exactly that sequence.
 */
export function addFilesToMeter(
  meterIndex: number,
  picked: ArrayLike<File> | null,
  maxPerMeter: number
): (prev: File[][]) => File[][] {
  const added = Array.from(picked ?? []);
  return (prev) =>
    prev.map((group, i) =>
      i === meterIndex ? [...group, ...added].slice(0, maxPerMeter) : group
    );
}
