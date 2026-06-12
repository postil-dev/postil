/**
 * Validation for org-supplied LLM API base URLs.
 *
 * The apiBase from org settings is handed to the spawned CLI as
 * POSTIL_API_BASE and fetched with the worker's network identity, so a
 * hostile value is a straight SSRF primitive (cloud metadata endpoints,
 * internal services, the database). Enforced at write time (settings form)
 * and again at read time before the CLI env is built, so rows written
 * before this check existed cannot slip through.
 */

export function validateApiBase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid API base URL (must be a public https:// URL)");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`API base URL must use https:, got ${parsed.protocol}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("API base URL must not contain credentials (userinfo)");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "" || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("API base URL must not point at localhost");
  }
  if (hostname.endsWith(".internal")) {
    throw new Error("API base URL must not point at .internal hostnames");
  }
  if (isPrivateIpLiteral(hostname)) {
    throw new Error("API base URL must not point at private, loopback, or link-local addresses");
  }
}

/** True when the validator accepts the URL; convenience for callers that branch. */
export function isValidApiBase(url: string): boolean {
  try {
    validateApiBase(url);
    return true;
  } catch {
    return false;
  }
}

function isPrivateIpLiteral(hostname: string): boolean {
  // The WHATWG URL parser already normalizes IPv4 forms (hex, octal,
  // dword) to dotted-quad, so a strict dotted-quad check covers them.
  const v4 = parseIpv4(hostname);
  if (v4) return isPrivateIpv4(v4);

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isPrivateIpv6(hostname.slice(1, -1));
  }
  // Node's URL.hostname keeps the brackets for IPv6, but accept bare
  // colon-form literals defensively.
  if (hostname.includes(":")) return isPrivateIpv6(hostname);
  return false;
}

function parseIpv4(hostname: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function isPrivateIpv4(o: number[]): boolean {
  const [a, b] = o as [number, number];
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateIpv6(literal: string): boolean {
  // Strip zone id (fe80::1%eth0).
  const addr = literal.split("%")[0]!.toLowerCase();

  // IPv4-mapped/compatible forms keep their IPv4 semantics.
  const v4Tail = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (v4Tail) {
    const v4 = parseIpv4(v4Tail[1]!);
    if (v4) return isPrivateIpv4(v4);
  }

  const groups = expandIpv6(addr);
  if (!groups) return true; // unparseable literal: fail closed
  const [g0] = groups as [number];
  const isZero = groups.every((g) => g === 0);
  if (isZero) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // ::ffff:0:0/96 IPv4-mapped expressed in hex groups.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isPrivateIpv4([
      groups[6]! >> 8,
      groups[6]! & 0xff,
      groups[7]! >> 8,
      groups[7]! & 0xff,
    ]);
  }
  return false;
}

/** Expand an IPv6 literal (hex groups only) to 8 numeric groups, or null. */
function expandIpv6(addr: string): number[] | null {
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] === "" ? [] : parts[0]!.split(":");
  const tail = parts.length === 2 ? (parts[1] === "" ? [] : parts[1]!.split(":")) : [];
  if (parts.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;
  const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}
