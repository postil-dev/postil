// Real Postil output, captured June 2026 by running the shipped CLI against the
// default model (deepseek/deepseek-v4-pro) on representative diffs. The envelope
// JSON files are the verbatim machine output; the diffs are what was reviewed.
import docs from "./docs.json";
import offbyone from "./offbyone.json";
import sqli from "./sqli.json";

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
  usage: { promptTokens: number; completionTokens: number };
}

export interface EvidenceCase {
  id: string;
  title: string;
  blurb: string;
  diff: string;
  envelope: EvidenceEnvelope;
}

const SQLI_DIFF = `diff --git a/src/users/lookup.ts b/src/users/lookup.ts
--- a/src/users/lookup.ts
+++ b/src/users/lookup.ts
@@ -12,8 +12,9 @@ export class UserLookup {
   async byEmail(email: string, sortBy?: string): Promise<User | null> {
-    const res = await this.db.query('SELECT * FROM users WHERE email = $1', [email]);
+    const order = sortBy ?? 'created_at';
+    const res = await this.db.query(\`SELECT * FROM users WHERE email = '\${email}' ORDER BY \${order}\`);
     return res.rows[0] ?? null;
   }
 }`;

const OFFBYONE_DIFF = `diff --git a/src/api/pagination.ts b/src/api/pagination.ts
--- a/src/api/pagination.ts
+++ b/src/api/pagination.ts
@@ -8,10 +8,12 @@ export interface Page<T> { items: T[]; nextCursor: string | null; }
-  let cursor: string | null = null;
-  do { const p = await fetchPage(cursor); out.push(...p.items); cursor = p.nextCursor; } while (cursor !== null);
-  return out;
+  let cursor: string | null = null;
+  for (let i = 1; i < MAX_PAGES; i++) {
+    const p = await fetchPage(cursor); out.push(...p.items); cursor = p.nextCursor;
+    if (cursor === null) return out;
+  }
+  throw new Error(\`pagination exceeded \${MAX_PAGES} pages\`);`;

const DOCS_DIFF = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -14,4 +14,4 @@ npm install @acme/widgets
-See the [API refrence](./docs/api.md) for more detials.
+See the [API reference](./docs/api.md) for more details.`;

export const EVIDENCE_CASES: EvidenceCase[] = [
  {
    id: "sqli",
    title: "A security regression",
    blurb:
      "A parameterized query is rewritten to interpolate user input. This is the kind of change Postil exists to stop at the gate.",
    diff: SQLI_DIFF,
    envelope: sqli as EvidenceEnvelope,
  },
  {
    id: "offbyone",
    title: "A subtle logic bug",
    blurb:
      "No security flag, no obvious smell — an off-by-one in a refactored pagination loop that truncates results and throws. The kind of bug a tired reviewer waves through.",
    diff: OFFBYONE_DIFF,
    envelope: offbyone as EvidenceEnvelope,
  },
  {
    id: "docs",
    title: "A clean change",
    blurb:
      "A typo fix in a README. Nothing affects the merge decision, so Postil says nothing at all. Silence is the feature most reviewers can't ship.",
    diff: DOCS_DIFF,
    envelope: docs as EvidenceEnvelope,
  },
];
