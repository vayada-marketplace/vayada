/**
 * A page of the stay being booked, on this address (VAY-2462): as is on a hotel's own address,
 * under the stay on an agency's (`/stays/<slug>/book`, `/stays/<slug>/booking/<reference>`). The
 * stay's home ("/") is its rooms: its own page, or the stay page on the agency's address.
 *
 * `base` is "" on a hotel's address, so every path stays exactly as it was there.
 */
export function stayPath(base: string, path: string): string {
  if (!base) return path;
  if (path === "/") return base;
  if (path.startsWith("/?") || path.startsWith("/#")) return base + path.slice(1);
  return base + path;
}
