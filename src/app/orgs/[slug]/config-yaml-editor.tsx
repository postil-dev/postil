"use client";

import { useEffect, useState } from "react";
import { isMap, parseDocument } from "yaml";

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

interface ConfigControlValues {
  severityThreshold: string | null;
  minConfidence: string;
  maxFindings: string;
  gateFailOn: string | null;
  gateOnError: string | null;
  contentPolicyEnabled: string | null;
  ignore: string;
}

function readControlValues(text: string): ConfigControlValues | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  if (doc.contents !== null && !isMap(doc.contents)) return null;
  const scalar = (path: string[]): string | null => {
    const value = doc.getIn(path);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : null;
  };
  const ignoreValue = doc.toJS()?.ignore;
  return {
    severityThreshold: scalar(["severityThreshold"]),
    minConfidence: scalar(["minConfidence"]) ?? "",
    maxFindings: scalar(["maxFindings"]) ?? "",
    gateFailOn: scalar(["gate", "failOn"]),
    gateOnError: scalar(["gate", "onError"]),
    contentPolicyEnabled: scalar(["contentPolicy", "enabled"]),
    ignore: Array.isArray(ignoreValue)
      ? ignoreValue.filter((entry) => typeof entry === "string").join("\n")
      : "",
  };
}

function withValue(text: string, path: string[], value: unknown): string {
  const doc = parseDocument(text);
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
    doc.setIn(path, value);
  }
  if (doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0)) {
    return "";
  }
  return String(doc);
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
        The options return when the YAML parses again. Fix it in the text field below.
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
        </select>
        <span className="mt-1 block text-charcoal/55">
          Findings at or above this severity fail the gate.
        </span>
      </label>
      <label className="block text-xs">
        <span className="font-medium">On review outage</span>
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
          What the gate does when a review cannot complete.
        </span>
      </label>
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
