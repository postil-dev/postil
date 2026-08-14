import { isAlias, isScalar, parse, parseDocument, stringify, visit } from "yaml";

import {
  FINDING_KINDS,
  parseFindingKind,
  type FindingKind,
} from "./finding-kinds";

const ROOT_FIELDS = [
  "enabled",
  "ignore",
  "severityThreshold",
  "minConfidence",
  "maxFindings",
  "reviewer",
  "review",
  "gate",
  "model",
  "contentPolicy",
] as const;
const REVIEWER_FIELDS = ["tone", "focus"] as const;
const REVIEW_FIELDS = [
  "onClean",
  "findingPresentation",
  "uncertaintyResolution",
  "conciseFindings",
] as const;
const GATE_FIELDS = ["failOn", "onError", "blockOnKinds"] as const;
const MODEL_FIELDS = ["name", "cascade", "scorer", "apiBase", "apiFormat", "consensus"] as const;
const CONTENT_POLICY_FIELDS = ["enabled"] as const;
const CLI_YAML_CORE_TAGS = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:null",
]);
const MAX_FINDINGS = 20n;
const MAX_USIZE = 18_446_744_073_709_551_615n;
const CLI_UNSIGNED_INTEGER = /^\+?(?:0|[1-9][0-9]*|0b[01]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;
function resolveRadixInteger(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[-+]/, "");
  const parsed = BigInt(unsigned);
  return negative ? -parsed : parsed;
}

function stringifyRadixInteger(
  node: { value: unknown },
  radix: number,
  prefix: string,
): string {
  const value = typeof node.value === "bigint" ? node.value : BigInt(node.value as number);
  const sign = value < 0n ? "-" : "";
  const unsigned = value < 0n ? -value : value;
  return `${sign}${prefix}${unsigned.toString(radix)}`;
}

const YAML_BINARY_INTEGER_TAG = {
  default: true,
  format: "BIN",
  identify: (value: unknown) => typeof value === "bigint" || Number.isInteger(value),
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?0b[01]+$/,
  resolve: resolveRadixInteger,
  stringify: (node: { value: unknown }) => stringifyRadixInteger(node, 2, "0b"),
};
const YAML_OCTAL_INTEGER_TAG = {
  default: true,
  format: "OCT",
  identify: (value: unknown) => typeof value === "bigint" || Number.isInteger(value),
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?0o[0-7]+$/,
  resolve: resolveRadixInteger,
  stringify: (node: { value: unknown }) => stringifyRadixInteger(node, 8, "0o"),
};
const YAML_HEXADECIMAL_INTEGER_TAG = {
  default: true,
  format: "HEX",
  identify: (value: unknown) => typeof value === "bigint" || Number.isInteger(value),
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?0x[0-9a-fA-F]+$/,
  resolve: resolveRadixInteger,
  stringify: (node: { value: unknown }) => stringifyRadixInteger(node, 16, "0x"),
};

type Severity = "info" | "warn" | "error";
type GateLevel = Severity | "never";

export interface ParsedPostilConfig {
  enabled?: boolean | null;
  ignore?: string[] | null;
  severityThreshold?: Severity | null;
  minConfidence?: number | null;
  maxFindings?: number | null;
  reviewer?: {
    tone?: string | null;
    focus?: string[] | null;
  } | null;
  review?: {
    onClean?: "skip" | "comment" | null;
    findingPresentation?: "reviewComments" | "checkAnnotations" | null;
    uncertaintyResolution?: boolean | null;
    conciseFindings?: boolean | null;
  } | null;
  gate?: {
    failOn?: GateLevel | null;
    onError?: "block" | "advisory" | null;
    blockOnKinds?: FindingKind[] | null;
  } | null;
  model?: {
    name?: string | null;
    cascade?: string[] | null;
    scorer?: string | null;
    apiBase?: string | null;
    apiFormat?: "openai-compatible" | "anthropic" | null;
    consensus?: bigint | null;
  } | null;
  contentPolicy?: {
    enabled?: boolean | null;
  } | null;
}

export interface ParsedPostilConfigYaml {
  config: ParsedPostilConfig;
  raw: Record<string, unknown>;
}

export interface PostilConfigYamlIssue {
  message: string;
  path: string;
}

export type PostilConfigYamlInspection =
  | { ok: true; parsed: ParsedPostilConfigYaml }
  | { ok: false; issue: PostilConfigYamlIssue; raw: Record<string, unknown> | null };

class ConfigIssue extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export function parsePostilYamlDocument(configYaml: string) {
  return parseDocument(configYaml, {
    customTags: [
      YAML_BINARY_INTEGER_TAG,
      YAML_OCTAL_INTEGER_TAG,
      YAML_HEXADECIMAL_INTEGER_TAG,
    ],
    intAsBigInt: true,
    schema: "core",
  });
}

/** Parse and normalize the `.postil.yaml` schema accepted by the hosted CLI. */
export function parsePostilConfigYaml(configYaml: string): ParsedPostilConfigYaml {
  const inspected = inspectPostilConfigYaml(configYaml);
  if (!inspected.ok) throw new Error(inspected.issue.message);
  return inspected.parsed;
}

/** Return the same schema decision to browser controls without throwing during an edit. */
export function inspectPostilConfigYaml(configYaml: string): PostilConfigYamlInspection {
  const doc = parsePostilYamlDocument(configYaml);
  const parseIssue = doc.errors[0] ?? doc.warnings[0];
  if (parseIssue) {
    return {
      ok: false,
      issue: { path: "", message: `Config YAML is invalid: ${parseIssue.message}` },
      raw: null,
    };
  }
  if (hasUnsupportedYamlTag(doc)) {
    return {
      ok: false,
      issue: {
        path: "",
        message: "YAML tags are not supported in review configuration.",
      },
      raw: null,
    };
  }

  let rawValue: unknown;
  try {
    rawValue = doc.contents === null ? {} : doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issue: { path: "", message: `Config YAML is invalid: ${detail}` },
      raw: null,
    };
  }
  if (!isRecord(rawValue)) {
    return {
      ok: false,
      issue: { path: "", message: "Config YAML root must be a mapping." },
      raw: null,
    };
  }

  try {
    return {
      ok: true,
      parsed: { raw: rawValue, config: normalizeConfig(rawValue, doc) },
    };
  } catch (error) {
    if (!(error instanceof ConfigIssue)) throw error;
    return {
      ok: false,
      issue: { path: error.path, message: error.message },
      raw: rawValue,
    };
  }
}

function hasUnsupportedYamlTag(doc: ReturnType<typeof parsePostilYamlDocument>): boolean {
  let unsupported = false;
  visit(doc, {
    Node: (_key, node) => {
      if (!("tag" in node) || typeof node.tag !== "string") return;
      if (CLI_YAML_CORE_TAGS.has(node.tag)) return;
      unsupported = true;
      return visit.BREAK;
    },
  });
  return unsupported;
}

function parseConfig(configYaml: string): unknown {
  try {
    return parse(configYaml);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Config YAML is invalid: ${detail}`);
  }
}

/** Validate an authorable `.postil.yaml` body before it reaches storage. */
export function validateOrgConfigYaml(configYaml: string): void {
  const { raw } = parsePostilConfigYaml(configYaml);
  if (Object.hasOwn(raw, "model")) {
    throw new Error(
      "Organization fallback config cannot set model options. Configure inference under Bring your own key.",
    );
  }
}

function normalizeConfig(
  raw: Record<string, unknown>,
  doc: ReturnType<typeof parsePostilYamlDocument>,
): ParsedPostilConfig {
  rejectUnknownFields(raw, ROOT_FIELDS, "");
  const config: ParsedPostilConfig = {};
  if (Object.hasOwn(raw, "enabled")) config.enabled = nullable(raw.enabled, booleanValue, "enabled");
  if (Object.hasOwn(raw, "ignore")) config.ignore = nullable(raw.ignore, stringList, "ignore");
  if (Object.hasOwn(raw, "severityThreshold")) {
    config.severityThreshold = nullable(
      raw.severityThreshold,
      severityValue,
      "severityThreshold",
    );
  }
  if (Object.hasOwn(raw, "minConfidence")) {
    config.minConfidence = nullable(
      raw.minConfidence,
      (entry, path) => confidenceValue(entry, path, doc),
      "minConfidence",
    );
  }
  if (Object.hasOwn(raw, "maxFindings")) {
    const value = nullable(
      raw.maxFindings,
      (entry, path) => integerValue(entry, path, doc),
      "maxFindings",
    );
    if (value !== null && (value < 1n || value > MAX_FINDINGS)) {
      invalid("maxFindings", "maxFindings must be in 1..=20.");
    }
    config.maxFindings = value === null ? null : Number(value);
  }
  if (Object.hasOwn(raw, "reviewer")) config.reviewer = reviewerValue(raw.reviewer);
  if (Object.hasOwn(raw, "review")) config.review = reviewValue(raw.review);
  if (Object.hasOwn(raw, "gate")) config.gate = gateValue(raw.gate);
  if (Object.hasOwn(raw, "model")) config.model = modelValue(raw.model, doc);
  if (Object.hasOwn(raw, "contentPolicy")) {
    config.contentPolicy = contentPolicyValue(raw.contentPolicy);
  }
  return config;
}

function reviewerValue(value: unknown): ParsedPostilConfig["reviewer"] {
  if (value === null) return null;
  const reviewer = mappingValue(value, "reviewer");
  rejectUnknownFields(reviewer, REVIEWER_FIELDS, "reviewer");
  const normalized: NonNullable<ParsedPostilConfig["reviewer"]> = {};
  if (Object.hasOwn(reviewer, "tone")) {
    normalized.tone = nullable(reviewer.tone, stringValue, "reviewer.tone");
  }
  if (Object.hasOwn(reviewer, "focus")) {
    normalized.focus = nullable(reviewer.focus, stringList, "reviewer.focus");
  }
  return normalized;
}

function reviewValue(value: unknown): ParsedPostilConfig["review"] {
  if (value === null) return null;
  const review = mappingValue(value, "review");
  rejectUnknownFields(review, REVIEW_FIELDS, "review");
  const normalized: NonNullable<ParsedPostilConfig["review"]> = {};
  if (Object.hasOwn(review, "onClean")) {
    normalized.onClean = nullable(
      review.onClean,
      (entry, path) => exactValue(entry, ["skip", "comment"] as const, path),
      "review.onClean",
    );
  }
  if (Object.hasOwn(review, "findingPresentation")) {
    normalized.findingPresentation = nullable(
      review.findingPresentation,
      (entry, path) => exactValue(entry, ["reviewComments", "checkAnnotations"] as const, path),
      "review.findingPresentation",
    );
  }
  if (Object.hasOwn(review, "uncertaintyResolution")) {
    normalized.uncertaintyResolution = nullable(
      review.uncertaintyResolution,
      booleanValue,
      "review.uncertaintyResolution",
    );
  }
  if (Object.hasOwn(review, "conciseFindings")) {
    normalized.conciseFindings = nullable(
      review.conciseFindings,
      booleanValue,
      "review.conciseFindings",
    );
  }
  return normalized;
}

function gateValue(value: unknown): ParsedPostilConfig["gate"] {
  if (value === null) return null;
  const gate = mappingValue(value, "gate");
  rejectUnknownFields(gate, GATE_FIELDS, "gate");
  const normalized: NonNullable<ParsedPostilConfig["gate"]> = {};
  if (Object.hasOwn(gate, "failOn")) {
    normalized.failOn = nullable(gate.failOn, gateLevelValue, "gate.failOn");
  }
  if (Object.hasOwn(gate, "onError")) {
    normalized.onError = nullable(
      gate.onError,
      (entry, path) => exactValue(entry, ["block", "advisory"] as const, path),
      "gate.onError",
    );
  }
  if (Object.hasOwn(gate, "blockOnKinds")) {
    normalized.blockOnKinds = nullable(gate.blockOnKinds, findingKindList, "gate.blockOnKinds");
  }
  return normalized;
}

function modelValue(
  value: unknown,
  doc: ReturnType<typeof parsePostilYamlDocument>,
): ParsedPostilConfig["model"] {
  if (value === null) return null;
  const model = mappingValue(value, "model");
  rejectUnknownFields(model, MODEL_FIELDS, "model");
  const normalized: NonNullable<ParsedPostilConfig["model"]> = {};
  for (const field of ["name", "scorer", "apiBase"] as const) {
    if (Object.hasOwn(model, field)) {
      normalized[field] = nullable(model[field], stringValue, `model.${field}`);
    }
  }
  if (Object.hasOwn(model, "cascade")) {
    normalized.cascade = nullable(model.cascade, stringList, "model.cascade");
  }
  if (Object.hasOwn(model, "apiFormat")) {
    normalized.apiFormat = nullable(
      model.apiFormat,
      (entry, path) => exactValue(entry, ["openai-compatible", "anthropic"] as const, path),
      "model.apiFormat",
    );
  }
  if (Object.hasOwn(model, "consensus")) {
    const consensus = nullable(
      model.consensus,
      (entry, path) => integerValue(entry, path, doc),
      "model.consensus",
    );
    if (consensus !== null && (consensus < 1n || consensus > MAX_USIZE)) {
      invalid(
        "model.consensus",
        "model.consensus must be an integer in 1..=18446744073709551615.",
      );
    }
    normalized.consensus = consensus;
  }
  return normalized;
}

function contentPolicyValue(value: unknown): ParsedPostilConfig["contentPolicy"] {
  if (value === null) return null;
  const contentPolicy = mappingValue(value, "contentPolicy");
  rejectUnknownFields(contentPolicy, CONTENT_POLICY_FIELDS, "contentPolicy");
  const normalized: NonNullable<ParsedPostilConfig["contentPolicy"]> = {};
  if (Object.hasOwn(contentPolicy, "enabled")) {
    normalized.enabled = nullable(contentPolicy.enabled, booleanValue, "contentPolicy.enabled");
  }
  return normalized;
}

function nullable<T>(
  value: unknown,
  parseValue: (entry: unknown, path: string) => T,
  path: string,
): T | null {
  return value === null ? null : parseValue(value, path);
}

function mappingValue(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, `${path} must be a YAML mapping or null.`);
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, `${path} must be a boolean or null.`);
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, `${path} must be a string or null.`);
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(path, `${path} must be a list of strings or null.`);
  }
  return value;
}

function integerValue(
  value: unknown,
  path: string,
  doc: ReturnType<typeof parsePostilYamlDocument>,
): bigint {
  const source = scalarSource(doc, path);
  if (
    typeof value !== "bigint" ||
    (source !== null && !CLI_UNSIGNED_INTEGER.test(source))
  ) {
    invalid(path, `${path} must be an unsigned integer or null.`);
  }
  return value;
}

function confidenceValue(
  value: unknown,
  path: string,
  doc: ReturnType<typeof parsePostilYamlDocument>,
): number {
  const source = scalarSource(doc, path)?.replace(/^[-+]/, "").toLowerCase();
  if (source?.startsWith("0b") || source?.startsWith("0o") || source?.startsWith("0x")) {
    invalid(path, "minConfidence must be a decimal number in 0..1.");
  }
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    invalid(path, "minConfidence must be in 0..1.");
  }
  return numeric;
}

function scalarSource(
  doc: ReturnType<typeof parsePostilYamlDocument>,
  path: string,
): string | null {
  let node = doc.getIn(path.split("."), true);
  if (isAlias(node)) node = node.resolve(doc);
  return isScalar(node) && typeof node.source === "string" ? node.source : null;
}

function severityValue(value: unknown, path: string): Severity {
  const raw = stringValue(value, path).trim().toLowerCase();
  if (["info", "low", "note", "notice"].includes(raw)) return "info";
  if (["warn", "warning", "medium"].includes(raw)) return "warn";
  if (["error", "high", "critical", "blocker"].includes(raw)) return "error";
  invalid(path, `${path} must resolve to info, warn, or error.`);
}

function gateLevelValue(value: unknown, path: string): GateLevel {
  const raw = stringValue(value, path);
  if (raw.toLowerCase() === "never") return "never";
  return severityValue(raw, path);
}

function findingKindList(value: unknown, path: string): FindingKind[] {
  if (!Array.isArray(value)) {
    invalid(path, `${path} must be a list of supported finding kinds or null.`);
  }
  const selected = new Set<FindingKind>();
  for (let index = 0; index < value.length; index += 1) {
    const kind = parseFindingKind(value[index]);
    if (!kind) {
      invalid(
        `${path}.${index}`,
        `${path} must list only risk, humanEscalation, guardrail, uncertainty, or contentPolicy.`,
      );
    }
    selected.add(kind);
  }
  return FINDING_KINDS.filter((kind) => selected.has(kind));
}

function exactValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalid(path, `${path} must be ${allowed.join(" or ")} or null.`);
  }
  return value as T[number];
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const field of Object.keys(value)) {
    if (allowed.includes(field)) continue;
    const fieldPath = path ? `${path}.${field}` : field;
    invalid(fieldPath, `${fieldPath} is not a supported config field.`);
  }
}

function invalid(path: string, message: string): never {
  throw new ConfigIssue(path, message);
}

/**
 * Remove model settings from rows saved before provider settings became BYOK-only.
 * Save-time validation prevents new rows; this worker-boundary filter prevents a
 * legacy organization fallback from overriding hosted inference.
 */
export function withoutOrgModelConfig(configYaml: string | null): string | null {
  return withoutModelConfig(configYaml);
}

/** Remove a model block while retaining every non-inference setting. */
export function withoutModelConfig(
  configYaml: string | null,
  outputFormat: "yaml" | "json" = "yaml",
): string | null {
  if (configYaml === null) return null;
  const config = parseConfig(configYaml);
  if (!isRecord(config) || !Object.hasOwn(config, "model")) return configYaml;
  const sanitized = { ...config };
  delete sanitized.model;
  if (Object.keys(sanitized).length === 0) return null;
  return outputFormat === "json"
    ? `${JSON.stringify(sanitized, null, 2)}\n`
    : stringify(sanitized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
