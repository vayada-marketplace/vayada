/** Rows for the dashboard's Bookings by channel card (VAY-2594). */

export type ChannelChange =
  | { kind: "up" | "down"; percent: number }
  | { kind: "unchanged" }
  /** No bookings from it in the period before. */
  | { kind: "new" };

export type ChannelRow = {
  key: string;
  bookings: number;
  /** Share of the range's bookings, 0–100. */
  share: number;
  /** The share's relative change against the period before. */
  change: ChannelChange;
  /** Bar width, 0–100, relative to the largest share. */
  width: number;
};

/**
 * Shares of the range's bookings, largest first, with each share's relative change against the
 * period before: (share now − share before) ÷ share before. Keys without bookings in the range are
 * left out.
 */
export function channelRows(
  counts: readonly { key: string; bookings: number; previous: number }[],
): ChannelRow[] {
  const total = counts.reduce((sum, row) => sum + row.bookings, 0);
  const previousTotal = counts.reduce((sum, row) => sum + row.previous, 0);
  if (total === 0) return [];
  const rows = counts
    .filter((row) => row.bookings > 0)
    .sort((a, b) => b.bookings - a.bookings || a.key.localeCompare(b.key))
    .map((row) => {
      const share = (row.bookings / total) * 100;
      const before = previousTotal > 0 ? (row.previous / previousTotal) * 100 : 0;
      let change: ChannelChange;
      if (before === 0) change = { kind: "new" };
      else {
        const percent = Math.round(((share - before) / before) * 100);
        change =
          percent === 0
            ? { kind: "unchanged" }
            : { kind: percent > 0 ? "up" : "down", percent: Math.abs(percent) };
      }
      return { key: row.key, bookings: row.bookings, share, change, width: 0 };
    });
  const largest = rows[0]?.share ?? 0;
  return rows.map((row) => ({ ...row, width: largest > 0 ? (row.share / largest) * 100 : 0 }));
}

/** Whole-number shares that add up to 100, largest remainders first. */
export function roundedShares(shares: readonly number[]): number[] {
  const floors = shares.map((share) => Math.floor(share));
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = shares
    .map((share, index) => ({ index, rest: share - Math.floor(share) }))
    .sort((a, b) => b.rest - a.rest);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] += 1;
    left -= 1;
  }
  return floors;
}
