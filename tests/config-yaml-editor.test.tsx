import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "yaml";

import {
  ConfigYamlEditor,
  readControlValues,
  toggleBlockOnKind,
  withValue,
} from "@/app/orgs/[slug]/config-yaml-editor";
import { FINDING_KINDS } from "@/lib/finding-kinds";
import { parsePostilConfigYaml } from "@/lib/org-review-config";

const CLI_STANDARD_TAG_CONFIG_YAML = `!!map
enabled: !!bool true
ignore: !!seq [!!str vendor/**]
minConfidence: !!float 0.8
maxFindings: !!int 20
reviewer: !!map
  tone: !!str terse
contentPolicy: !!map
  enabled: !!null null
`;

const CLI_TAG_REJECTED_CONFIG_YAML = [
  "enabled: !custom true\n",
  "enabled: !<tag:example.com,2026:value> true\n",
  "enabled: !!str true\n",
  "ignore: !!map {entry: vendor/**}\n",
] as const;

const CLI_ACCEPTED_CONFIG_YAML = [
  {
    name: "empty config",
    yaml: "",
  },
  {
    name: "every supported field",
    yaml: `enabled: false
ignore: [vendor/**]
severityThreshold: MEDIUM
minConfidence: 0
maxFindings: 20
reviewer:
  tone: terse
  focus: [security]
review:
  onClean: comment
  findingPresentation: checkAnnotations
  uncertaintyResolution: false
  conciseFindings: false
gate:
  failOn: CRITICAL
  onError: advisory
  blockOnKinds: [Risk, " humanEscalation ", GUARDRAIL, uncertainty, ContentPolicy, risk]
model:
  name: provider/model
  cascade: [provider/fallback]
  scorer: provider/scorer
  apiBase: https://example.com/v1
  apiFormat: anthropic
  consensus: 2
contentPolicy:
  enabled: false
`,
  },
  {
    name: "nullable sections",
    yaml: `enabled: null
ignore: null
severityThreshold: null
minConfidence: null
maxFindings: null
reviewer: null
review: null
gate: null
model: null
contentPolicy: null
`,
  },
  {
    name: "nullable section fields",
    yaml: `reviewer:
  tone: null
  focus: null
review:
  onClean: null
  findingPresentation: null
  uncertaintyResolution: null
  conciseFindings: null
gate:
  failOn: null
  onError: null
  blockOnKinds: null
model:
  name: null
  cascade: null
  scorer: null
  apiBase: null
  apiFormat: null
  consensus: null
contentPolicy:
  enabled: null
`,
  },
  {
    name: "aliases, anchors, and YAML integers",
    yaml: `ignore: &paths [vendor/**]
severityThreshold: notice
maxFindings: 0x14
reviewer:
  focus: *paths
gate:
  failOn: Never
  blockOnKinds: []
model:
  consensus: 0b10
`,
  },
  {
    name: "maximum usize consensus",
    yaml: "maxFindings: +0x14\nmodel:\n  consensus: 18446744073709551615\n",
  },
  {
    name: "YAML 1.1 directive with core scalar semantics",
    yaml: "%YAML 1.1\n---\nenabled: true\n",
  },
  {
    name: "explicit standard YAML core tags",
    yaml: CLI_STANDARD_TAG_CONFIG_YAML,
  },
] as const;

const CLI_REJECTED_CONFIG_YAML = [
  { name: "null root", yaml: "null\n" },
  { name: "scalar root", yaml: "enabled\n" },
  { name: "sequence root", yaml: "[]\n" },
  { name: "multiple documents", yaml: "---\n{}\n---\n{}\n" },
  { name: "duplicate fields", yaml: "enabled: true\nenabled: false\n" },
  { name: "custom YAML tag", yaml: "reviewer:\n  tone: !custom terse\n" },
  {
    name: "application YAML tag",
    yaml: "reviewer:\n  tone: !<tag:example.com,2026:value> terse\n",
  },
  { name: "mismatched string boolean tag", yaml: "enabled: !!str true\n" },
  { name: "mismatched mapping sequence tag", yaml: "ignore: !!map {entry: vendor/**}\n" },
  { name: "unknown root field", yaml: "futureOption: true\n" },
  { name: "unknown reviewer field", yaml: "reviewer:\n  futureOption: true\n" },
  { name: "unknown review field", yaml: "review:\n  futureOption: true\n" },
  { name: "unknown gate field", yaml: "gate:\n  futureOption: true\n" },
  { name: "unknown model field", yaml: "model:\n  futureOption: true\n" },
  { name: "unknown content policy field", yaml: "contentPolicy:\n  futureOption: true\n" },
  { name: "non-boolean enabled", yaml: 'enabled: "true"\n' },
  { name: "non-string ignore entry", yaml: "ignore: [1]\n" },
  { name: "unknown severity", yaml: "severityThreshold: urgent\n" },
  { name: "confidence below range", yaml: "minConfidence: -0.1\n" },
  { name: "non-finite confidence", yaml: "minConfidence: .nan\n" },
  { name: "zero max findings", yaml: "maxFindings: 0\n" },
  { name: "max findings above limit", yaml: "maxFindings: 21\n" },
  { name: "floating max findings", yaml: "maxFindings: 1.0\n" },
  { name: "leading-zero max findings", yaml: "maxFindings: 020\n" },
  { name: "non-string reviewer tone", yaml: "reviewer:\n  tone: 1\n" },
  { name: "non-list reviewer focus", yaml: "reviewer:\n  focus: security\n" },
  { name: "case-sensitive onClean", yaml: "review:\n  onClean: Comment\n" },
  {
    name: "unknown finding presentation",
    yaml: "review:\n  findingPresentation: comments\n",
  },
  {
    name: "non-boolean uncertainty resolution",
    yaml: 'review:\n  uncertaintyResolution: "false"\n',
  },
  { name: "spaced never", yaml: 'gate:\n  failOn: " never "\n' },
  { name: "case-sensitive onError", yaml: "gate:\n  onError: Advisory\n" },
  { name: "scalar blocking kind", yaml: "gate:\n  blockOnKinds: risk\n" },
  { name: "unknown blocking kind", yaml: "gate:\n  blockOnKinds: [futureKind]\n" },
  { name: "non-string model name", yaml: "model:\n  name: 1\n" },
  { name: "non-list model cascade", yaml: "model:\n  cascade: provider/model\n" },
  { name: "case-sensitive API format", yaml: "model:\n  apiFormat: ANTHROPIC\n" },
  { name: "zero consensus", yaml: "model:\n  consensus: 0\n" },
  {
    name: "consensus above usize",
    yaml: "model:\n  consensus: 18446744073709551616\n",
  },
  {
    name: "non-boolean content policy switch",
    yaml: 'contentPolicy:\n  enabled: "false"\n',
  },
  {
    name: "YAML 1.1 boolean alias",
    yaml: "%YAML 1.1\n---\nenabled: yes\n",
  },
  { name: "non-decimal confidence", yaml: "minConfidence: 0x1\n" },
] as const;

describe("ConfigYamlEditor blockOnKinds controls", () => {
  test("reads standard YAML core tags accepted by the CLI parser", () => {
    expect(readControlValues(CLI_STANDARD_TAG_CONFIG_YAML)).toMatchObject({
      minConfidence: "0.8",
      maxFindings: "20",
      ignore: "vendor/**",
    });
  });

  test("withholds controls for custom and field-mismatched YAML tags", () => {
    for (const configYaml of CLI_TAG_REJECTED_CONFIG_YAML) {
      expect(readControlValues(configYaml)).toBeNull();
    }
  });

  test("renders a native, labelled checkbox for every supported finding kind", () => {
    const markup = renderToStaticMarkup(
      <ConfigYamlEditor value={"gate:\n  blockOnKinds: []\n"} onChange={() => undefined} />,
    );

    expect(markup).toContain("<fieldset");
    expect(markup).toContain("<legend");
    expect((markup.match(/type=\"checkbox\"/g) ?? []).length).toBe(FINDING_KINDS.length);
    for (const label of [
      "Risk",
      "Maintainer decision needed",
      "Guardrail",
      "Uncertainty",
      "Content policy",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Default: Maintainer decision needed");
    expect(markup).toContain("independently of");
    expect(markup).toContain("unless Gate fails at is never");
    expect(markup).toContain("confidence of at least 0.30");
    expect(markup).toContain("After review filters are applied");
    expect(markup).toContain("disable all ordinary finding blocking");
    expect(markup).toContain("including selected kinds");
  });

  test("keeps omitted and null defaults, explicit empty lists, and configured values distinct", () => {
    const omitted = readControlValues("gate:\n  failOn: warn\n");
    const nullGate = readControlValues("gate: null\n");
    const nullKinds = readControlValues("gate:\n  blockOnKinds: null\n");
    const empty = readControlValues("gate:\n  blockOnKinds: []\n");
    const configured = readControlValues(
      'gate:\n  blockOnKinds: [CONTENTPOLICY, risk, Risk, " humanEscalation "]\n',
    );

    expect(omitted?.blockOnKinds).toEqual({
      state: "default",
      kinds: ["humanEscalation"],
    });
    expect(nullGate?.blockOnKinds).toEqual(omitted?.blockOnKinds);
    expect(nullKinds?.blockOnKinds).toEqual(omitted?.blockOnKinds);
    expect(empty?.blockOnKinds).toEqual({ state: "configured", kinds: [] });
    expect(configured?.blockOnKinds).toEqual({
      state: "configured",
      kinds: ["risk", "humanEscalation", "contentPolicy"],
    });
    expect(
      parse(
        withValue(
          "# Existing policy\ngate:\n  failOn: warn\n  blockOnKinds: [humanEscalation]\n",
          ["gate", "blockOnKinds"],
          undefined,
        ),
      ),
    ).toEqual({ gate: { failOn: "warn" } });
  });

  test("toggles every finding kind at gate.blockOnKinds without changing other policy", () => {
    let yaml = "# Team policy\nenabled: false\nminConfidence: 0.8\nignore: [vendor/**]\nreviewer:\n  tone: retain # Keep this\nreview:\n  conciseFindings: false\ngate:\n  failOn: warn\n  blockOnKinds: []\n";

    for (const kind of FINDING_KINDS) {
      const values = readControlValues(yaml);
      expect(values?.blockOnKinds.state).not.toBe("invalid");
      yaml = toggleBlockOnKind(yaml, values!.blockOnKinds, kind);
    }

    expect(parse(yaml)).toEqual({
      minConfidence: 0.8,
      ignore: ["vendor/**"],
      enabled: false,
      reviewer: { tone: "retain" },
      review: { conciseFindings: false },
      gate: { failOn: "warn", blockOnKinds: [...FINDING_KINDS] },
    });
    expect(yaml).toContain("# Team policy");
    expect(yaml).toContain("# Keep this");

    for (const kind of [...FINDING_KINDS].reverse()) {
      const values = readControlValues(yaml);
      yaml = toggleBlockOnKind(yaml, values!.blockOnKinds, kind);
    }
    expect(parse(yaml)).toEqual({
      minConfidence: 0.8,
      ignore: ["vendor/**"],
      enabled: false,
      reviewer: { tone: "retain" },
      review: { conciseFindings: false },
      gate: { failOn: "warn", blockOnKinds: [] },
    });
  });

  test("creates nested mappings when a CLI-compatible section is null", () => {
    expect(parse(withValue("gate: null\n", ["gate", "blockOnKinds"], ["risk"]))).toEqual({
      gate: { blockOnKinds: ["risk"] },
    });
    expect(
      parse(withValue("contentPolicy: null\n", ["contentPolicy", "enabled"], false)),
    ).toEqual({ contentPolicy: { enabled: false } });
  });

  test("preserves CLI integer notation during an unrelated structured edit", () => {
    const yaml = "maxFindings: 0b10100 # Keep notation\ngate:\n  blockOnKinds: []\n";
    const values = readControlValues(yaml);

    const changed = toggleBlockOnKind(yaml, values!.blockOnKinds, "risk");

    expect(changed).toContain("maxFindings: 0b10100 # Keep notation");
    expect(parsePostilConfigYaml(changed).config.maxFindings).toBe(20);
  });

  test("does not rewrite malformed blockOnKinds input", () => {
    const yaml = "gate:\n  blockOnKinds: [risk, unsupported]\n";
    const values = readControlValues(yaml);

    expect(values?.blockOnKinds).toEqual({ state: "invalid", kinds: [] });
    expect(toggleBlockOnKind(yaml, values!.blockOnKinds, "risk")).toBe(yaml);
    expect(
      renderToStaticMarkup(<ConfigYamlEditor value={yaml} onChange={() => undefined} />),
    ).toContain('role="alert"');
    expect(readControlValues("gate: blockOnKinds\n")).toBeNull();
  });

  test("preserves schema-unknown YAML by withholding structured edits", () => {
    const yaml = "futureOption: keep # untouched\ngate:\n  blockOnKinds: []\n";

    expect(readControlValues(yaml)).toBeNull();
    expect(withValue(yaml, ["gate", "blockOnKinds"], ["risk"])).toContain(
      "futureOption: keep # untouched",
    );
  });
});

describe("hosted CLI config schema parity", () => {
  for (const fixture of CLI_ACCEPTED_CONFIG_YAML) {
    test(`accepts ${fixture.name}`, () => {
      expect(() => parsePostilConfigYaml(fixture.yaml)).not.toThrow();
    });
  }

  for (const fixture of CLI_REJECTED_CONFIG_YAML) {
    test(`rejects ${fixture.name}`, () => {
      expect(() => parsePostilConfigYaml(fixture.yaml)).toThrow();
    });
  }

  test("normalizes CLI severity aliases and set-like finding kinds", () => {
    const parsed = parsePostilConfigYaml(CLI_ACCEPTED_CONFIG_YAML[1].yaml).config;

    expect(parsed.severityThreshold).toBe("warn");
    expect(parsed.gate?.failOn).toBe("error");
    expect(parsed.gate?.blockOnKinds).toEqual([...FINDING_KINDS]);
  });
});
