/** Full ARI sync is 499 calendar dates, inclusive of hotel-local today (VAY-2108).
 * Channex holds 500 days but opens the newest one only at its daily roll, about two hours after
 * the hotel's midnight (Tiga, 2026-11-15: 18:01Z = 02:01 Asia/Makassar). Our scheduled sync starts
 * at the hotel's midnight, so a send for today + 499 before that roll is accepted (200, task
 * success) but nothing is stored, and its readback can never match. One day less is always open. */
export const DEFAULT_FULL_ARI_DAYS_AHEAD = 498;
