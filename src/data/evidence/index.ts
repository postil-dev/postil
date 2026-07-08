// Real, verifiable catches from Postil's own repos. Every card here is a
// review that actually ran on a public pull request — the finding text is
// copied verbatim from the postil/review check-run output on that PR's head
// commit (via `gh api repos/<org>/<repo>/commits/<sha>/check-runs`), and
// `sourceUrl` links to the PR so anyone can verify it independently. Token
// usage is not exposed by the GitHub check-run API (it lives in the hosted
// envelope store), so real cases omit it rather than invent a number.
//
// The one exception is `fixture: true` on the "clean" case below: that case
// demonstrates what a passing review looks like in this UI and is built from
// a real fix diff, but its envelope (no findings, silent pass) is asserted
// here rather than pulled from a live check-run, so it is labeled as such.

export interface EvidenceFinding {
  path: string;
  line: number;
  endLine?: number;
  severity: "info" | "warn" | "error";
  kind: string;
  confidence: number;
  title: string;
  body: string;
}

export interface EvidenceEnvelope {
  summary: string;
  silent: boolean;
  findings: EvidenceFinding[];
  gate: { failOn: string; failing: boolean };
  modelUsed: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface EvidenceCase {
  id: string;
  category: string;
  title: string;
  blurb: string;
  diff: string;
  envelope: EvidenceEnvelope;
  /** Link to the real, public PR this review ran on. Omitted only for `fixture` cases. */
  sourceUrl?: string;
  /** True only for the one seeded (non-live) case, labeled explicitly in the UI. */
  fixture?: true;
}

const MIGRATION_DIFF = `diff --git a/drizzle/0001_org_indexes_and_constraints.sql b/drizzle/0001_org_indexes_and_constraints.sql
--- /dev/null
+++ b/drizzle/0001_org_indexes_and_constraints.sql
@@ -0,0 +1,3 @@
+CREATE INDEX "installations_org_idx" ON "installations" USING btree ("org_id");--> statement-breakpoint
+CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
+CREATE UNIQUE INDEX "organizations_github_org_id_idx" ON "organizations" USING btree ("github_org_id");`;

const DOCS_SHA_DIFF = `diff --git a/src/app/docs/quickstart/page.tsx b/src/app/docs/quickstart/page.tsx
--- a/src/app/docs/quickstart/page.tsx
+++ b/src/app/docs/quickstart/page.tsx
@@ -66,9 +66,9 @@ jobs:
     steps:
       - uses: actions/checkout@v4
-      - uses: postil-dev/postil-action@main
+      - uses: postil-dev/postil-action@468923c378eacf9541a689f7d8c316ba4d5c6024
         with:
-          cli-ref: v0.1.2
+          cli-ref: 3776f251db771dd74615305d7c2b0bc21b9fb2df
         env:
           GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}`;

const RUST_PANIC_DIFF = `diff --git a/src/diff.rs b/src/diff.rs
--- a/src/diff.rs
+++ b/src/diff.rs
@@ -85,6 +85,20 @@ impl DiffIndex {
     }
 }

+pub fn cap_raw_diff(text: &str, max_bytes: usize) -> (&str, bool) {
+    if text.len() <= max_bytes {
+        return (text, false);
+    }
+    let cut = text[..max_bytes]
+        .rfind('\\n')
+        .map(|i| i + 1)
+        .unwrap_or_else(|| {
+            let mut b = max_bytes;
+            while b > 0 && !text.is_char_boundary(b) {
+                b -= 1;
+            }
+            b
+        });
+    (&text[..cut], true)
+}
+
 /// Parse a unified diff (git format). Tolerant of mode lines, renames, and
 /// "\\ No newline at end of file" markers.
 pub fn parse(text: &str) -> Diff {`;

const RUST_PANIC_FIX_DIFF = `diff --git a/src/diff.rs b/src/diff.rs
--- a/src/diff.rs
+++ b/src/diff.rs
@@ -122,15 +122,18 @@ pub fn cap_raw_diff(text: &str, max_bytes: usize) -> (&str, bool) {
     if text.len() <= max_bytes {
         return (text, false);
     }
+    // The cap can land inside a multi-byte character; back up to a char
+    // boundary before slicing, or the index below panics on non-ASCII input.
+    let mut b = max_bytes;
+    while b > 0 && !text.is_char_boundary(b) {
+        b -= 1;
+    }
     // Cut at the last newline at or before the cap so the final retained hunk
-    // line stays intact; if there is none, hard-cut at a char boundary.
-    let cut = text[..max_bytes]
-        .rfind('\\n')
-        .map(|i| i + 1)
-        .unwrap_or_else(|| {
-            let mut b = max_bytes;
-            while b > 0 && !text.is_char_boundary(b) {
-                b -= 1;
-            }
-            b
-        });
+    // line stays intact; if there is none, hard-cut at the char boundary.
+    let cut = text[..b].rfind('\\n').map(|i| i + 1).unwrap_or(b);
     (&text[..cut], true)
 }`;

const YQ_DIFF = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -75,6 +75,9 @@ jobs:
     steps:
       - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
       - name: "Extract run: blocks from action.yml"
+        # yq is not installed on ubuntu-latest by default; this only works
+        # because the current runner image happens to preinstall it.
         run: |
           set -euo pipefail
           mkdir -p "$RUNNER_TEMP/action-scripts"
           count=$(yq '.runs.steps | length' action.yml)
           for i in $(seq 0 $((count - 1))); do
             shell=$(yq -r ".runs.steps[$i].shell // \\"\\"" action.yml)
             script=$(yq -r ".runs.steps[$i].run // \\"\\"" action.yml)`;

const FLY_MIGRATE_DIFF = `diff --git a/fly.toml b/fly.toml
--- a/fly.toml
+++ b/fly.toml
@@ -23,6 +23,9 @@ primary_region = "lhr"
 POSTIL_CLI_REV = "v0.1.2"
 NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com"

+[deploy]
+release_command = "bun run db:migrate"
+
 [processes]
 web = "bun run start"
 worker = "bun run worker"`;

const CLEAN_FIX_DIFF = `diff --git a/src/diff.rs b/src/diff.rs
--- a/src/diff.rs
+++ b/src/diff.rs
@@ -122,15 +122,18 @@ pub fn cap_raw_diff(text: &str, max_bytes: usize) -> (&str, bool) {
     if text.len() <= max_bytes {
         return (text, false);
     }
+    // The cap can land inside a multi-byte character; back up to a char
+    // boundary before slicing, or the index below panics on non-ASCII input.
+    let mut b = max_bytes;
+    while b > 0 && !text.is_char_boundary(b) {
+        b -= 1;
+    }
     // Cut at the last newline at or before the cap so the final retained hunk
-    // line stays intact; if there is none, hard-cut at a char boundary.
-    let cut = text[..max_bytes]
-        .rfind('\\n')
-        .map(|i| i + 1)
-        .unwrap_or_else(|| {
-            let mut b = max_bytes;
-            while b > 0 && !text.is_char_boundary(b) {
-                b -= 1;
-            }
-            b
-        });
+    // line stays intact; if there is none, hard-cut at the char boundary.
+    let cut = text[..b].rfind('\\n').map(|i| i + 1).unwrap_or(b);
     (&text[..cut], true)
 }
+
+#[test]
+fn raw_diff_cap_handles_multibyte_at_the_boundary() {
+    let s = "é".repeat(100);
+    let (capped, truncated) = cap_raw_diff(&s, 99);
+    assert!(truncated);
+    assert_eq!(capped.len(), 98);
+}`;

export const EVIDENCE_CASES: EvidenceCase[] = [
  {
    id: "migration-dedup",
    category: "Migration safety",
    title: "A unique index that would fail against production duplicates",
    blurb:
      "A migration adds a unique index to close a race condition the PR is fixing. The catch: the race it fixes could already have produced the duplicate rows the new index would reject.",
    diff: MIGRATION_DIFF,
    sourceUrl: "https://github.com/postil-dev/postil/pull/275",
    envelope: {
      summary:
        "The migration adding a unique index on organizations.github_org_id risks failing in production if duplicate rows already exist from the pre-fix race condition.",
      silent: false,
      findings: [
        {
          path: "drizzle/0001_org_indexes_and_constraints.sql",
          line: 3,
          severity: "error",
          kind: "risk",
          confidence: 0.85,
          title: "Add deduplication before unique index migration",
          body:
            "The migration adding a unique index on organizations.github_org_id risks failing in production if duplicate rows already exist from the pre-fix race condition. Verify the production dataset is clean or add a deduplication step before the CREATE UNIQUE INDEX.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "swapped-shas",
    category: "Docs / CI",
    title: "Two repos' commit SHAs swapped in a copy-pasted example",
    blurb:
      "A docs edit pins the GitHub Action to its own SHA, then reuses that same SHA for cli-ref — which is supposed to pin the separate CLI repository. Every reader who copies the snippet gets a broken CI run.",
    diff: DOCS_SHA_DIFF,
    sourceUrl: "https://github.com/postil-dev/postil/pull/280",
    envelope: {
      summary:
        "The quickstart and docs index snippets incorrectly change cli-ref from the CLI repository's SHA to the action repository's SHA; users who copy them will get a CLI resolution failure in CI.",
      silent: false,
      findings: [
        {
          path: "src/app/docs/quickstart/page.tsx",
          line: 71,
          severity: "error",
          kind: "risk",
          confidence: 0.9,
          title: "Fix cli-ref to use CLI repository SHA",
          body:
            "The quickstart and docs index snippets incorrectly change cli-ref from the CLI repository's SHA to the action repository's SHA; users who copy them will get a CLI resolution failure in CI.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "utf8-panic",
    category: "Correctness",
    title: "A byte-slice panic on non-ASCII input",
    blurb:
      "A new size cap slices raw diff text at a byte offset without checking for a UTF-8 character boundary. On a diff containing non-ASCII file content, the cap can land mid-character and the process panics. The shipped fix backs up to the nearest char boundary before slicing — exactly what the finding suggested.",
    diff: RUST_PANIC_DIFF,
    sourceUrl: "https://github.com/postil-dev/postil-cli/pull/25",
    envelope: {
      summary:
        "The new cap_raw_diff helper can panic when MAX_RAW_DIFF_BYTES lands inside a multi-byte UTF-8 character, because text[..max_bytes] requires a char boundary.",
      silent: false,
      findings: [
        {
          path: "src/diff.rs",
          line: 127,
          severity: "error",
          kind: "risk",
          confidence: 0.95,
          title: "Panic in raw-diff cap on non-ASCII input",
          body:
            "The new cap_raw_diff helper can panic when MAX_RAW_DIFF_BYTES lands inside a multi-byte UTF-8 character, because `text[..max_bytes]` requires a char boundary. This aborts the review on large diffs containing non-ASCII file content instead of truncating safely.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "yq-not-installed",
    category: "CI",
    title: "A CI job that only works by accident",
    blurb:
      "A new self-test workflow shells out to yq to extract steps from action.yml. ubuntu-latest does not ship yq by default — the job happens to pass only because the runner image in use at the time preinstalled it.",
    diff: YQ_DIFF,
    sourceUrl: "https://github.com/postil-dev/postil-action/pull/4",
    envelope: {
      summary:
        "The shellcheck CI job invokes yq without installing it, so the workflow will fail on ubuntu-latest runners where yq is not present by default.",
      silent: false,
      findings: [
        {
          path: ".github/workflows/ci.yml",
          line: 83,
          severity: "error",
          kind: "risk",
          confidence: 0.9,
          title: "shellcheck job uses yq but never installs it",
          body:
            "The shellcheck CI job invokes `yq` without installing it, so the workflow will fail on `ubuntu-latest` runners where `yq` is not present by default.",
        },
      ],
      gate: { failOn: "error", failing: true },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "migration-ordering-escalation",
    category: "Deploy",
    title: "“I can't verify this — confirm it yourself.”",
    blurb:
      "Not every finding is a detection. Wiring migrations into the Fly release command is correct, but whether the pending migration is backward-compatible with the code still running during the deploy window is a call Postil cannot make from a diff. It says so and asks, instead of guessing either way.",
    diff: FLY_MIGRATE_DIFF,
    sourceUrl: "https://github.com/postil-dev/postil/pull/279",
    envelope: {
      summary:
        "The new [deploy] release_command runs migrations automatically before new machines start, but while old web and worker instances remain active. If pending migrations are not backward-compatible with the currently deployed code, running instances may error during the deploy window.",
      silent: false,
      findings: [
        {
          path: "fly.toml",
          line: 33,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.9,
          title: "Confirm automatic migration deploy ordering with owner",
          body:
            "The new `[deploy]` `release_command` runs migrations automatically before new machines start, but while old web and worker instances remain active. If pending migrations are not backward-compatible with the currently deployed code, running instances may error during the deploy window. This is a deployment-ordering judgment call, not something gradeable from the diff alone — confirm the ordering is safe before relying on it in production.",
        },
      ],
      gate: { failOn: "error", failing: false },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "clean-fix",
    category: "Clean",
    title: "A clean fix, verified silent",
    blurb:
      "The fix for the UTF-8 panic above. Postil's own gate passed it — a seeded fixture asserting that same silent outcome for this UI, since a live check-run's zero-finding output has no comment thread to screenshot.",
    diff: CLEAN_FIX_DIFF,
    fixture: true,
    envelope: {
      summary: "",
      silent: true,
      findings: [],
      gate: { failOn: "error", failing: false },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
];
