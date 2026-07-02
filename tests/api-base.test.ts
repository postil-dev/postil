import { describe, expect, test } from "bun:test";

import { type DnsLookup, isValidApiBase, validateApiBase } from "@/lib/api-base";

// Hermetic resolver: the syntactic/literal cases never reach DNS, but the
// hostname cases below drive resolution explicitly through these stubs so the
// suite never touches the network.
const resolvesTo =
  (...addresses: string[]): DnsLookup =>
  async () =>
    addresses.map((address) => ({ address }));
const resolveFails: DnsLookup = async () => {
  throw new Error("ENOTFOUND");
};
const resolvesEmpty: DnsLookup = async () => [];

// A resolver that must never be consulted: literal/syntactic rejections and
// public IP literals should short-circuit before DNS.
const neverResolves: DnsLookup = async () => {
  throw new Error("resolver should not have been called");
};

describe("validateApiBase", () => {
  test("accepts public https URLs whose host resolves publicly", async () => {
    await expect(
      validateApiBase("https://openrouter.ai/api/v1", resolvesTo("104.18.0.1")),
    ).resolves.toBeUndefined();
    await expect(
      validateApiBase("https://api.example.com:8443/v1", resolvesTo("93.184.216.34")),
    ).resolves.toBeUndefined();
  });

  test("rejects non-https schemes without resolving", async () => {
    await expect(validateApiBase("http://openrouter.ai/api/v1", neverResolves)).rejects.toThrow(
      /https/,
    );
    await expect(validateApiBase("ftp://example.com", neverResolves)).rejects.toThrow(/https/);
    await expect(validateApiBase("not a url", neverResolves)).rejects.toThrow(/invalid/);
  });

  test("rejects userinfo without resolving", async () => {
    await expect(
      validateApiBase("https://user:pass@example.com/v1", neverResolves),
    ).rejects.toThrow(/credentials/);
    await expect(validateApiBase("https://user@example.com/v1", neverResolves)).rejects.toThrow(
      /credentials/,
    );
  });

  test("rejects loopback and localhost", async () => {
    await expect(validateApiBase("https://localhost/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://api.localhost/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://127.0.0.1/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://127.1.2.3/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://[::1]/v1", neverResolves)).rejects.toThrow();
  });

  test("rejects private and link-local IPv4 literals without resolving", async () => {
    await expect(validateApiBase("https://10.0.0.1/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://172.16.0.1/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://172.31.255.255/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://192.168.1.1/v1", neverResolves)).rejects.toThrow();
    await expect(
      validateApiBase("https://169.254.169.254/latest/meta-data", neverResolves),
    ).rejects.toThrow();
    await expect(validateApiBase("https://0.0.0.0/v1", neverResolves)).rejects.toThrow();
  });

  test("accepts public-range boundary neighbours (public IP literals skip DNS)", async () => {
    await expect(
      validateApiBase("https://172.15.0.1/v1", neverResolves),
    ).resolves.toBeUndefined();
    await expect(
      validateApiBase("https://172.32.0.1/v1", neverResolves),
    ).resolves.toBeUndefined();
    await expect(validateApiBase("https://11.0.0.1/v1", neverResolves)).resolves.toBeUndefined();
  });

  test("rejects obfuscated IPv4 forms the URL parser normalizes", async () => {
    // 0x7f000001 and 017700000001 both normalize to 127.0.0.1.
    await expect(validateApiBase("https://0x7f000001/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://2130706433/v1", neverResolves)).rejects.toThrow();
  });

  test("rejects private IPv6 literals and mapped IPv4 without resolving", async () => {
    await expect(validateApiBase("https://[fc00::1]/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://[fd12:3456::1]/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://[fe80::1]/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://[::]/v1", neverResolves)).rejects.toThrow();
    await expect(validateApiBase("https://[::ffff:10.0.0.1]/v1", neverResolves)).rejects.toThrow();
    await expect(
      validateApiBase("https://[::ffff:169.254.169.254]/v1", neverResolves),
    ).rejects.toThrow();
  });

  test("rejects .internal hostnames without resolving", async () => {
    await expect(
      validateApiBase("https://metadata.google.internal/v1", neverResolves),
    ).rejects.toThrow();
  });

  test("rejects a public-looking host that resolves to metadata/RFC1918 space", async () => {
    await expect(
      validateApiBase("https://evil.example.com/v1", resolvesTo("169.254.169.254")),
    ).rejects.toThrow(/resolve/);
    await expect(
      validateApiBase("https://evil.example.com/v1", resolvesTo("10.1.2.3")),
    ).rejects.toThrow(/resolve/);
    // Rejects when ANY of the returned addresses is internal, not just all.
    await expect(
      validateApiBase("https://evil.example.com/v1", resolvesTo("93.184.216.34", "127.0.0.1")),
    ).rejects.toThrow(/resolve/);
    // IPv6 loopback via DNS.
    await expect(
      validateApiBase("https://evil.example.com/v1", resolvesTo("::1")),
    ).rejects.toThrow(/resolve/);
  });

  test("rejects when resolution fails or returns nothing", async () => {
    await expect(validateApiBase("https://ghost.example.com/v1", resolveFails)).rejects.toThrow(
      /resolved/,
    );
    await expect(
      validateApiBase("https://ghost.example.com/v1", resolvesEmpty),
    ).rejects.toThrow(/resolve/);
  });

  test("isValidApiBase mirrors the throwing validator", async () => {
    expect(await isValidApiBase("https://openrouter.ai/api/v1", resolvesTo("104.18.0.1"))).toBe(
      true,
    );
    expect(await isValidApiBase("http://openrouter.ai/api/v1", neverResolves)).toBe(false);
    expect(await isValidApiBase("https://169.254.169.254", neverResolves)).toBe(false);
    expect(await isValidApiBase("https://evil.example.com", resolvesTo("10.0.0.1"))).toBe(false);
  });
});
