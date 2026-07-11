import { afterEach, beforeEach } from "bun:test";

type ConsoleMethod = "error" | "log" | "warn";

const methods: ConsoleMethod[] = ["error", "log", "warn"];
const originals = new Map<ConsoleMethod, typeof console[ConsoleMethod]>();

for (const method of methods) {
  originals.set(method, console[method]);
}

beforeEach(() => {
  for (const method of methods) {
    console[method] = () => undefined;
  }
});

afterEach(() => {
  for (const method of methods) {
    console[method] = originals.get(method)!;
  }
});
