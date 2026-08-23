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

/** Dashboard KPI cards: ~296px of content width at every breakpoint. */
export function heroValueSize(value: string): string {
  const n = value.length
  if (n <= 6) return 'text-[40px] lg:text-[44px]'
  if (n <= 9) return 'text-[34px] lg:text-[38px]'
  if (n <= 13) return 'text-[28px] lg:text-[30px]'
  return 'text-[24px]'
}

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
