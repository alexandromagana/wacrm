/**
 * Type scales for headline numbers.
 *
 * A stat tile's width is fixed by its grid, but the value inside it is
 * not: "43" and "MX$2,544,859" land in the same box. Picking one font
 * size for both either wastes the tile on short values or pushes long
 * currency past the edge, so the size steps down with character count.
 *
 * Budgets assume the bold UI sans with tight tracking, where a digit
 * runs about 0.6em, plus a little slack for separators and the currency
 * prefix.
 */

/**
 * Dense analytics strips (pipeline header, and anything else laying
 * six stats across one row). These tiles are only ~125px wide on a
 * phone, so long values stay near the base size there and open up on
 * the wider desktop grid.
 */
export function panelValueSize(value: string): string {
  const n = value.length
  if (n <= 6) return 'text-xl sm:text-2xl'
  if (n <= 9) return 'text-lg sm:text-2xl'
  if (n <= 13) return 'text-base sm:text-xl xl:text-2xl'
  return 'text-sm sm:text-lg xl:text-xl'
}
