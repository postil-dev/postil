"use client";

import { useState } from "react";

type OsId = "linux" | "macos" | "windows";

const TABS: { id: OsId; label: string }[] = [
  { id: "linux", label: "Linux" },
  { id: "macos", label: "macOS" },
  { id: "windows", label: "Windows" },
];

const COMMANDS: Record<OsId, string> = {
  linux: `curl -fsSL https://postil.dev/install.sh | sh
# or build from source:
# cargo install --git https://github.com/postil-dev/postil-cli --locked
export MODEL_API_KEY=sk-or-...
export POSTIL_API_KEY="$MODEL_API_KEY"`,
  macos: `curl -fsSL https://postil.dev/install.sh | sh
# or build from source:
# cargo install --git https://github.com/postil-dev/postil-cli --locked
export MODEL_API_KEY=sk-or-...
export POSTIL_API_KEY="$MODEL_API_KEY"`,
  windows: `# Native Windows binaries are unavailable; install.sh covers Linux and macOS only.
# Use WSL, then follow the Linux tab above.

# Without WSL, build from source with a Rust toolchain:
cargo install --git https://github.com/postil-dev/postil-cli --locked
$env:MODEL_API_KEY = "sk-or-..."
$env:POSTIL_API_KEY = $env:MODEL_API_KEY`,
};

/**
 * OS-aware install instructions. Linux and macOS share install.sh (it
 * detects arch/libc itself); Windows has no prebuilt binary in the release
 * matrix, so it gets the explicit fallback: WSL, or build from source.
 */
export function OsInstallTabs() {
  const [active, setActive] = useState<OsId>("linux");

  return (
    <div>
      <div role="tablist" aria-label="Operating system" className="flex gap-1 border-b border-stone">
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`os-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`os-panel-${tab.id}`}
              onClick={() => setActive(tab.id)}
              className={`-mb-px rounded-t-card border border-b-0 px-4 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "border-stone bg-charcoal text-ivory"
                  : "border-transparent text-charcoal/70 hover:text-charcoal"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {TABS.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`os-panel-${tab.id}`}
          aria-labelledby={`os-tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          <pre tabIndex={0} aria-label={`Install command, ${tab.label}`}>
            <code>{COMMANDS[tab.id]}</code>
          </pre>
        </div>
      ))}
      {active === "windows" && (
        <p className="text-sm text-charcoal/70">
          The release workflow does not build a{" "}
          <code>x86_64-pc-windows-msvc</code> target, so there is no
          signed <code>.exe</code> to download or verify with{" "}
          <code>Invoke-WebRequest</code>. WSL gets you the real, signed Linux
          binary; building from source needs a Rust toolchain installed
          locally.
        </p>
      )}
    </div>
  );
}
