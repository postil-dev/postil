"use client";

import { useEffect, useState } from "react";
import { isMap } from "yaml";

import {
  DEFAULT_BLOCK_ON_KINDS,
  FINDING_KINDS,
  isFindingKind,
  type FindingKind,
} from "@/lib/finding-kinds";
import {
  inspectPostilConfigYaml,
  parsePostilYamlDocument,
} from "@/lib/org-review-config";

/**
 * Structured controls over the organization fallback `.postil.yaml`. The YAML
 * text stays the single source of truth: controls read their values from it and
 * every change rewrites the text through the YAML document API, so comments and
 * keys the form does not cover survive round trips. "Default" removes the key.
 *
 * Typed fields keep a local draft so partial input ("0.") edits the field
 * without rewriting the YAML until it is a value; the draft adopts the YAML
 * whenever the two no longer agree, which covers direct edits to the text.
 */

const SEVERITIES = ["info", "warn", "error"] as const;
const BLOCKING_KIND_LABELS: Record<FindingKind, string> = {
  risk: "Risk",
  humanEscalation: "Maintainer decision needed",
  guardrail: "Guardrail",
  uncertainty: "Uncertainty",
  contentPolicy: "Content policy",
};

export interface BlockOnKindsValue {
  state: "default" | "configured" | "invalid";
  kinds: FindingKind[];
}

interface ConfigControlValues {
  severityThreshold: string | null;
  minConfidence: string;
  maxFindings: string;
  gateFailOn: string | null;
  gateOnError: string | null;
  blockOnKinds: BlockOnKindsValue;
  contentPolicyEnabled: string | null;
  ignore: string;
}

export function readControlValues(text: string): ConfigControlValues | null {
  const inspected = inspectPostilConfigYaml(text);
  const invalidBlockOnKinds =
    !inspected.ok && inspected.issue.path.startsWith("gate.blockOnKinds");
  if (!inspected.ok && (!invalidBlockOnKinds || inspected.raw === null)) return null;
  const config = (inspected.ok ? inspected.parsed.config : inspected.raw) as Record<
    string,
    unknown
  >;
  const scalar = (path: string[]): string | null => {
    let value: unknown = config;
    for (const segment of path) {
      if (!isRecord(value)) return null;
      value = value[segment];
    }
    return typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean"
      ? String(value)
      : null;
  };
  const gate = isRecord(config.gate) ? config.gate : undefined;
  const ignoreValue = config.ignore;
  const rawBlockOnKinds = gate?.blockOnKinds;
  const blockOnKinds: BlockOnKindsValue =
    invalidBlockOnKinds
      ? { state: "invalid", kinds: [] }
      : rawBlockOnKinds === undefined || rawBlockOnKinds === null
      ? { state: "default", kinds: [...DEFAULT_BLOCK_ON_KINDS] }
      : Array.isArray(rawBlockOnKinds) && rawBlockOnKinds.every(isFindingKind)
        ? { state: "configured", kinds: rawBlockOnKinds }
        : { state: "invalid", kinds: [] };
  return {
    severityThreshold: scalar(["severityThreshold"]),
    minConfidence: scalar(["minConfidence"]) ?? "",
    maxFindings: scalar(["maxFindings"]) ?? "",
    gateFailOn: scalar(["gate", "failOn"]),
    gateOnError: scalar(["gate", "onError"]),
    blockOnKinds,
    contentPolicyEnabled: scalar(["contentPolicy", "enabled"]),
    ignore: Array.isArray(ignoreValue)
      ? ignoreValue.filter((entry) => typeof entry === "string").join("\n")
      : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withValue(text: string, path: string[], value: unknown): string {
  const doc = parsePostilYamlDocument(text);
  // Controls only render for parseable mapping (or empty) documents; anything
  // else passes through untouched rather than risking a wipe or a throw.
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    return text;
  }
  if (value === undefined) {
    doc.deleteIn(path);
    // Drop a now-empty parent map so clearing gate.failOn leaves no `gate: {}`.
    if (path.length > 1) {
      const parent = doc.getIn(path.slice(0, -1));
      if (isMap(parent) && parent.items.length === 0) doc.deleteIn(path.slice(0, -1));
    }
  } else {
    for (let length = 1; length < path.length; length += 1) {
      const parentPath = path.slice(0, length);
      if (doc.getIn(parentPath) === null) doc.setIn(parentPath, doc.createNode({}));
    }
    doc.setIn(path, value);
  }
  if (doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0)) {
    return "";
  }
  return String(doc);
}

export function toggleBlockOnKind(
  text: string,
  blockOnKinds: BlockOnKindsValue,
  kind: FindingKind,
): string {
  if (blockOnKinds.state === "invalid") return text;
  const selected = new Set(blockOnKinds.kinds);
  if (selected.has(kind)) selected.delete(kind);
  else selected.add(kind);
  return withValue(
    text,
    ["gate", "blockOnKinds"],
    FINDING_KINDS.filter((candidate) => selected.has(candidate)),
  );
}

function normalizeIgnore(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function numbersAgree(draft: string, yamlValue: string): boolean {
  if (draft.trim() === "" && yamlValue === "") return true;
  return Number(draft) === Number(yamlValue);
}

export function ConfigYamlEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const values = readControlValues(value);
  const [drafts, setDrafts] = useState({
    minConfidence: values?.minConfidence ?? "",
    maxFindings: values?.maxFindings ?? "",
    ignore: values?.ignore ?? "",
  });
  const yamlMinConfidence = values?.minConfidence ?? null;
  const yamlMaxFindings = values?.maxFindings ?? null;
  const yamlIgnore = values?.ignore ?? null;
  useEffect(() => {
    if (yamlMinConfidence === null || yamlMaxFindings === null || yamlIgnore === null) return;
    setDrafts((current) => ({
      minConfidence: numbersAgree(current.minConfidence, yamlMinConfidence)
        ? current.minConfidence
        : yamlMinConfidence,
      maxFindings: numbersAgree(current.maxFindings, yamlMaxFindings)
        ? current.maxFindings
        : yamlMaxFindings,
      ignore: normalizeIgnore(current.ignore) === yamlIgnore ? current.ignore : yamlIgnore,
    }));
  }, [yamlMinConfidence, yamlMaxFindings, yamlIgnore]);

  if (!values) {
    return (
      <p className="mt-2 rounded-card border border-stone/70 bg-ivory px-3 py-2 text-xs text-charcoal/60">
        The options return when this is valid Postil YAML. Fix it in the text field below.
      </p>
    );
  }

  const selectClass =
    "mt-1 w-full rounded-card border border-stone bg-ivory px-2 py-1.5 text-xs focus:border-gate focus:outline-none";
  const inputClass =
    "mt-1 w-full rounded-card border border-stone bg-ivory px-2 py-1.5 font-mono text-xs focus:border-gate focus:outline-none";
  const setSelect = (path: string[], raw: string, kind: "string" | "boolean") => {
    onChange(
      withValue(value, path, raw === "" ? undefined : kind === "boolean" ? raw === "true" : raw),
    );
  };
  const editNumber = (field: "minConfidence" | "maxFindings", path: string[]) =>
    (raw: string) => {
      setDrafts((current) => ({ ...current, [field]: raw }));
      if (raw.trim() === "") {
        onChange(withValue(value, path, undefined));
        return;
      }
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) onChange(withValue(value, path, numeric));
    };

  return (
    <div className="mt-2 grid gap-3 rounded-card border border-stone/70 bg-ivory p-3 sm:grid-cols-3">
      <label className="block text-xs">
        <span className="font-medium">Gate fails at</span>
        <select
          value={values.gateFailOn ?? ""}
          onChange={(event) => setSelect(["gate", "failOn"], event.target.value, "string")}
          className={selectClass}
        >
          <option value="">default (error)</option>
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>{severity}</option>
          ))}
          <option value="never">never</option>
        </select>
        <span className="mt-1 block text-charcoal/55">
          Sets the gate failure policy. Choose never to disable all ordinary finding blocking,
          including selected kinds.
        </span>
      </label>
      <label className="block text-xs">
        <span className="font-medium">Direct publish outage</span>
        <select
          value={values.gateOnError ?? ""}
          onChange={(event) => setSelect(["gate", "onError"], event.target.value, "string")}
          className={selectClass}
        >
          <option value="">default (block)</option>
          <option value="block">block</option>
          <option value="advisory">advisory</option>
        </select>
        <span className="mt-1 block text-charcoal/55">
          Gate outcome for provider failures during direct CLI publication.
          Hosted runs use the organization merge-gate setting.
        </span>
      </label>
      <fieldset className="block text-xs sm:col-span-3">
        <legend className="font-medium">Block finding kinds</legend>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          {values.blockOnKinds.state !== "default" && (
            <button
              type="button"
              onClick={() => onChange(withValue(value, ["gate", "blockOnKinds"], undefined))}
              className="text-rust underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-gate"
            >
              Use default
            </button>
          )}
        </div>
        <span className="mt-1 block text-charcoal/55">
          After review filters are applied, selected kinds can fail the gate independently of
          severity, unless Gate fails at is never. Maintainer decisions also require confidence of
          at least 0.30. Gate fails at applies the severity threshold.
        </span>
        {values.blockOnKinds.state === "invalid" ? (
          <p role="alert" className="mt-2 text-rust">
            <code>gate.blockOnKinds</code> must be a list of supported finding kinds. Fix it in
            the YAML source.
          </p>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {FINDING_KINDS.map((kind) => {
              const checked = values.blockOnKinds.kinds.includes(kind);
              return (
                <label
                  key={kind}
                  className="flex items-center gap-2 rounded-card border border-stone/70 px-2 py-1.5"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange(toggleBlockOnKind(value, values.blockOnKinds, kind))}
                    className="size-3.5 accent-gate"
                  />
                  <span>{BLOCKING_KIND_LABELS[kind]}</span>
                </label>
              );
            })}
          </div>
        )}
        <span className="mt-1 block text-charcoal/55">
          Default: Maintainer decision needed. An empty selection blocks no finding kinds.
        </span>
      </fieldset>
      <label className="block text-xs">
        <span className="font-medium">Content policy</span>
        <select
          value={values.contentPolicyEnabled ?? ""}
          onChange={(event) =>
            setSelect(["contentPolicy", "enabled"], event.target.value, "boolean")
          }
          className={selectClass}
        >
          <option value="">default (on)</option>
          <option value="true">on</option>
          <option value="false">off</option>
        </select>
        <span className="mt-1 block text-charcoal/55">
          The built-in prose and content baseline.
        </span>
      </label>
      <label className="block text-xs">
        <span className="font-medium">Keep findings from</span>
        <select
          value={values.severityThreshold ?? ""}
          onChange={(event) => setSelect(["severityThreshold"], event.target.value, "string")}
          className={selectClass}
        >
          <option value="">default (info)</option>
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>{severity}</option>
          ))}
        </select>
        <span className="mt-1 block text-charcoal/55">
          Findings below this severity are dropped.
        </span>
      </label>
      <label className="block text-xs">
        <span className="font-medium">Minimum confidence</span>
        <input
          type="text"
          inputMode="decimal"
          value={drafts.minConfidence}
          onChange={(event) => editNumber("minConfidence", ["minConfidence"])(event.target.value)}
          placeholder="default 0.6"
          className={inputClass}
        />
        <span className="mt-1 block text-charcoal/55">
          Findings below this confidence, 0 to 1, are dropped.
        </span>
      </label>
      <label className="block text-xs">
        <span className="font-medium">Max findings per review</span>
        <input
          type="text"
          inputMode="numeric"
          value={drafts.maxFindings}
          onChange={(event) => editNumber("maxFindings", ["maxFindings"])(event.target.value)}
          placeholder="default 20"
          className={inputClass}
        />
        <span className="mt-1 block text-charcoal/55">
          Excess findings are counted as suppressed.
        </span>
      </label>
      <label className="block text-xs sm:col-span-3">
        <span className="font-medium">Ignored paths</span>
        <textarea
          value={drafts.ignore}
          onChange={(event) => {
            const raw = event.target.value;
            setDrafts((current) => ({ ...current, ignore: raw }));
            const globs = normalizeIgnore(raw);
            onChange(
              withValue(
                value,
                ["ignore"],
                globs.length > 0 ? globs.split("\n") : undefined,
              ),
            );
          }}
          placeholder={"vendor/**\n**/*.lock"}
          spellCheck={false}
          rows={2}
          className={`${inputClass} min-h-0`}
        />
        <span className="mt-1 block text-charcoal/55">
          One glob per line, excluded from review.
        </span>
      </label>
    </div>
  );
}
