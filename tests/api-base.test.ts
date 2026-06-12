import { describe, expect, test } from "bun:test";

import { isValidApiBase, validateApiBase } from "@/lib/api-base";

describe("validateApiBase", () => {
  test("accepts public https URLs", () => {
    expect(() => validateApiBase("https://openrouter.ai/api/v1")).not.toThrow();
    expect(() => validateApiBase("https://api.example.com:8443/v1")).not.toThrow();
  });

  test("rejects non-https schemes", () => {
    expect(() => validateApiBase("http://openrouter.ai/api/v1")).toThrow(/https/);
    expect(() => validateApiBase("ftp://example.com")).toThrow(/https/);
    expect(() => validateApiBase("not a url")).toThrow(/invalid/);
  });

  test("rejects userinfo", () => {
    expect(() => validateApiBase("https://user:pass@example.com/v1")).toThrow(/credentials/);
    expect(() => validateApiBase("https://user@example.com/v1")).toThrow(/credentials/);
  });

  test("rejects loopback and localhost", () => {
    expect(() => validateApiBase("https://localhost/v1")).toThrow();
    expect(() => validateApiBase("https://api.localhost/v1")).toThrow();
    expect(() => validateApiBase("https://127.0.0.1/v1")).toThrow();
    expect(() => validateApiBase("https://127.1.2.3/v1")).toThrow();
    expect(() => validateApiBase("https://[::1]/v1")).toThrow();
  });

  test("rejects private and link-local IPv4 ranges", () => {
    expect(() => validateApiBase("https://10.0.0.1/v1")).toThrow();
    expect(() => validateApiBase("https://172.16.0.1/v1")).toThrow();
    expect(() => validateApiBase("https://172.31.255.255/v1")).toThrow();
    expect(() => validateApiBase("https://192.168.1.1/v1")).toThrow();
    expect(() => validateApiBase("https://169.254.169.254/latest/meta-data")).toThrow();
    expect(() => validateApiBase("https://0.0.0.0/v1")).toThrow();
  });

  test("accepts public-range boundary neighbours", () => {
    expect(() => validateApiBase("https://172.15.0.1/v1")).not.toThrow();
    expect(() => validateApiBase("https://172.32.0.1/v1")).not.toThrow();
    expect(() => validateApiBase("https://11.0.0.1/v1")).not.toThrow();
  });

  test("rejects obfuscated IPv4 forms the URL parser normalizes", () => {
    // 0x7f000001 and 017700000001 both normalize to 127.0.0.1.
    expect(() => validateApiBase("https://0x7f000001/v1")).toThrow();
    expect(() => validateApiBase("https://2130706433/v1")).toThrow();
  });

  test("rejects private IPv6 ranges and mapped IPv4", () => {
    expect(() => validateApiBase("https://[fc00::1]/v1")).toThrow();
    expect(() => validateApiBase("https://[fd12:3456::1]/v1")).toThrow();
    expect(() => validateApiBase("https://[fe80::1]/v1")).toThrow();
    expect(() => validateApiBase("https://[::]/v1")).toThrow();
    expect(() => validateApiBase("https://[::ffff:10.0.0.1]/v1")).toThrow();
    expect(() => validateApiBase("https://[::ffff:169.254.169.254]/v1")).toThrow();
  });

  test("rejects .internal hostnames", () => {
    expect(() => validateApiBase("https://metadata.google.internal/v1")).toThrow();
  });

  test("isValidApiBase mirrors the throwing validator", () => {
    expect(isValidApiBase("https://openrouter.ai/api/v1")).toBe(true);
    expect(isValidApiBase("http://openrouter.ai/api/v1")).toBe(false);
    expect(isValidApiBase("https://169.254.169.254")).toBe(false);
  });
});
