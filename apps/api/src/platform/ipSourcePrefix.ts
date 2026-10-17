import { isIPv6 } from "node:net";

function expandIpv4Tail(ip: string): string {
  const match = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (!match) return ip;
  const octets = match[1].split(".").map(Number);
  return `${ip.slice(0, -match[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${(
    (octets[2] << 8) |
    octets[3]
  ).toString(16)}`;
}

/** Rate-limit source key: the IPv4 address, or the /64 of an IPv6 address (IPv4-mapped → IPv4). */
export function sourcePrefix(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const [head, tail = ""] = expandIpv4Tail(ip.toLowerCase()).split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(
    (group) => Number.parseInt(group, 16),
  );
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}
