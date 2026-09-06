// Public example data contains verifiable reviews from Postil's public repositories.
// Finding titles and bodies are copied byte-for-byte from check-run annotations.
// Review and gate titles and summaries are copied byte-for-byte from their
// check-runs. A single trailing newline is removed when present. Each card links
// to the public pull request it came from. Check-run IDs and the reviewed head
// SHA are retained in this file as the verification record. Commit and check-run
// URLs on merged PRs expire from GitHub's UI after a retention window, so the UI
// links only the PR. The silent case links a pull request that has no visible
// postil comments at all. Token usage is not exposed by the GitHub check-run
// API, so these cases omit it.

export interface EvidenceFinding {
  path: string;
  line: number;
  endLine?: number;
  severity: "info" | "warn" | "error";
  kind: string;
  confidence?: number;
  title: string;
  body: string;
}

export interface EvidenceEnvelope {
  checkRunTitle: string;
  summary: string;
  silent: boolean;
  findings: EvidenceFinding[];
  gate: {
    title: string;
    summary: string;
    failOn: string;
    failing: boolean;
  };
  modelUsed: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface EvidenceCase {
  id: string;
  category: string;
  title: string;
  blurb: string;
  diff: string;
  diffIsExcerpt: boolean;
  envelope: EvidenceEnvelope;
  sourceUrl: string;
  checkRunUrl: string;
  gateCheckRunUrl: string;
  /** Permalink to the visible postil review on the PR. Absent when the review is silent (no visible comment). */
  reviewUrl?: string;
  /** The exact head commit reviewed by checkRunUrl. */
  commitSha: string;
}

const MIGRATION_DEDUP_DIFF = `diff --git a/drizzle/0001_org_indexes_and_constraints.sql b/drizzle/0001_org_indexes_and_constraints.sql
--- /dev/null
+++ b/drizzle/0001_org_indexes_and_constraints.sql
@@ -0,0 +1,3 @@
+CREATE INDEX "installations_org_idx" ON "installations" USING btree ("org_id");--> statement-breakpoint
+CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
+CREATE UNIQUE INDEX "organizations_github_org_id_idx" ON "organizations" USING btree ("github_org_id");
\\ No newline at end of file`;

const SWAPPED_SHAS_DIFF = `diff --git a/src/app/docs/quickstart/page.tsx b/src/app/docs/quickstart/page.tsx
--- a/src/app/docs/quickstart/page.tsx
+++ b/src/app/docs/quickstart/page.tsx
@@ -47,7 +47,9 @@ postil review --base main\`}</code>
       <h2>2. GitHub Actions</h2>
       <p>
         The composite action installs a CLI pinned to a full 40-character
-        commit SHA and runs the same review in CI:
+        commit SHA and runs the same review in CI. The action itself has no
+        tagged releases yet, so pin it to a commit SHA too —{" "}
+        <code>@v1</code> will resolve once the first tag ships:
       </p>
       <pre tabIndex={0} aria-label="Code sample">
         <code>{\`name: review
@@ -64,23 +66,31 @@ jobs:
       checks: write
     steps:
       - uses: actions/checkout@v4
-      - uses: postil-dev/postil-action@v1
+      - uses: postil-dev/postil-action@0d92d604e753fd6831baeeff85e3f2ff4a84bd6c # main, @v1 resolves after the first tagged release
         with:
-          cli-ref: 87f4bf08b63712d3600030a7c458f0b790cfc0d5
+          cli-ref: 0d92d604e753fd6831baeeff85e3f2ff4a84bd6c
         env:
           GITHUB_TOKEN: \\\${{ secrets.GITHUB_TOKEN }}
           OPENROUTER_API_KEY: \\\${{ secrets.OPENROUTER_API_KEY }}\`}</code>
       </pre>
       <p>
-        The <code>cli-ref</code> above is the current blessed CLI ref; check the{" "}
+        Both SHAs above are the current heads of their respective{" "}
+        <code>main</code> branches; check the{" "}
+        <a
+          href="https://github.com/postil-dev/postil-action"
+          rel="noopener"
+        >
+          postil-action repository
+        </a>{" "}
+        and the{" "}
         <a
           href="https://github.com/postil-dev/postil-cli"
           rel="noopener"
         >
           postil-cli repository
         </a>{" "}
         for the latest. The action refuses anything but a full 40-character
-        commit SHA — tags move, SHAs do not.
+        commit SHA for <code>cli-ref</code> — tags move, SHAs do not.
       </p>
\x20
       <h2>3. Hosted GitHub App</h2>
diff --git a/src/app/docs/page.tsx b/src/app/docs/page.tsx
--- a/src/app/docs/page.tsx
+++ b/src/app/docs/page.tsx
@@ -38,6 +38,11 @@ const CARDS = [
     title: "Envelope schema",
     body: "The JSON contract between the CLI and everything else: findings, counts, gate, usage.",
   },
+  {
+    href: "/docs/content-policy",
+    title: "Content policy",
+    body: "Opt-in review of prose in the diff: fabricated claims, AI-authorship residue, and the built-in baseline.",
+  },
   {
     href: "/docs/gitlab",
     title: "GitLab",
@@ -82,9 +87,9 @@ postil doctor            # verify endpoint, key, and model
 postil review --staged
\x20
 # CI (GitHub Actions) — @v1 resolves after the first tagged release
-- uses: postil-dev/postil-action@v1
+- uses: postil-dev/postil-action@0d92d604e753fd6831baeeff85e3f2ff4a84bd6c
   with:
-    cli-ref: 87f4bf08b63712d3600030a7c458f0b790cfc0d5
+    cli-ref: 0d92d604e753fd6831baeeff85e3f2ff4a84bd6c
\x20
 # hosted
 Install the GitHub App; reviews start on the next PR.\`}</code>`;

const UTF8_PANIC_DIFF = `diff --git a/src/diff.rs b/src/diff.rs
--- a/src/diff.rs
+++ b/src/diff.rs
@@ -47,6 +47,10 @@ impl Diff {
 #[derive(Debug, Default)]
 pub struct DiffIndex {
     ranges: HashMap<String, Vec<RangeInclusive<u32>>>,
+    /// Reserved synthetic-path line ranges that only content-policy findings may
+    /// ground against (e.g. the rendered PR title/description). Kept separate
+    /// from \`ranges\` so a non-content-policy finding cannot exploit them.
+    content_policy_ranges: HashMap<String, RangeInclusive<u32>>,
 }
\x20
 impl DiffIndex {
@@ -63,7 +67,29 @@ impl DiffIndex {
                 }
             }
         }
-        DiffIndex { ranges }
+        DiffIndex {
+            ranges,
+            content_policy_ranges: HashMap::new(),
+        }
+    }
+
+    /// Register \`path\` as groundable for content-policy findings over lines
+    /// \`1..=count\` (the numbered PR title/description block). No-op when
+    /// \`count == 0\`.
+    pub fn add_content_policy_path(&mut self, path: &str, count: u32) {
+        if count > 0 {
+            self.content_policy_ranges
+                .insert(path.to_string(), 1..=count);
+        }
+    }
+
+    /// True when \`(path, line)\` is a registered content-policy anchor. Used only
+    /// for \`kind: contentPolicy\` findings; the normal \`contains\` path never
+    /// consults these ranges.
+    pub fn contains_content_policy(&self, path: &str, line: u32) -> bool {
+        self.content_policy_ranges
+            .get(path)
+            .is_some_and(|r| r.contains(&line))
     }
\x20
     pub fn contains(&self, path: &str, line: u32) -> bool {
@@ -282,7 +308,10 @@ pub fn render_annotated(diff: &Diff, max_bytes: usize) -> (String, bool) {
             break 'files;
         }
         for hunk in &file.hunks {
-            if push(&mut out, &format!("@@ starting at line {} @@\\n", hunk.new_start)) {
+            if push(
+                &mut out,
+                &format!("@@ starting at line {} @@\\n", hunk.new_start),
+            ) {
                 truncated = true;
                 break 'files;
             }
@@ -428,6 +457,22 @@ Binary files a/img.png and b/img.png differ
         assert_eq!(same, "small\\n");
     }
\x20
+    #[test]
+    fn content_policy_ranges_are_separate_from_diff_ranges() {
+        let d = parse(SAMPLE);
+        let mut idx = DiffIndex::build(&d);
+        idx.add_content_policy_path(".postil/pr-description", 3);
+        // Registered content-policy anchor: lines 1..=3 groundable there.
+        assert!(idx.contains_content_policy(".postil/pr-description", 1));
+        assert!(idx.contains_content_policy(".postil/pr-description", 3));
+        assert!(!idx.contains_content_policy(".postil/pr-description", 4));
+        // The normal contains() never consults content-policy ranges.
+        assert!(!idx.contains(".postil/pr-description", 1));
+        // A zero-count registration is a no-op.
+        idx.add_content_policy_path(".postil/empty", 0);
+        assert!(!idx.contains_content_policy(".postil/empty", 1));
+    }
+
     #[test]
     fn hunk_header_without_count() {
         assert_eq!(parse_hunk_header("-1 +5 @@"), Some((5, 1, 1)));`;

const YQ_NOT_INSTALLED_DIFF = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- /dev/null
+++ b/.github/workflows/ci.yml
@@ -0,0 +1,170 @@
+name: CI
+
+on:
+  pull_request:
+  push:
+    branches: [main]
+
+permissions:
+  contents: read
+
+jobs:
+  actionlint:
+    runs-on: ubuntu-latest
+    steps:
+      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
+      - name: Install actionlint
+        env:
+          ACTIONLINT_VERSION: "1.7.12"
+          ACTIONLINT_SHA256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
+        run: |
+          set -euo pipefail
+          cd "$RUNNER_TEMP"
+          curl -fsSL -o actionlint.tar.gz \\
+            "https://github.com/rhysd/actionlint/releases/download/v\${ACTIONLINT_VERSION}/actionlint_\${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
+          echo "\${ACTIONLINT_SHA256}  actionlint.tar.gz" | sha256sum -c -
+          tar -xzf actionlint.tar.gz actionlint
+          chmod +x actionlint
+          echo "$RUNNER_TEMP" >> "$GITHUB_PATH"
+      - name: actionlint (workflow files)
+        run: actionlint -color
+      - name: Validate action.yml structure
+        shell: bash
+        run: |
+          set -euo pipefail
+          # actionlint does not validate action.yml itself, only workflow
+          # files, so check the composite action's structure separately:
+          # it must parse as YAML and carry the fields every consumer and
+          # the GitHub Actions runner require.
+          python3 - <<'PY'
+          import sys
+          import yaml
+
+          with open("action.yml") as f:
+              doc = yaml.safe_load(f)
+
+          errors = []
+          for field in ("name", "description", "runs"):
+              if field not in doc:
+                  errors.append(f"missing required top-level field: {field}")
+
+          runs = doc.get("runs", {})
+          if runs.get("using") != "composite":
+              errors.append("runs.using must be 'composite'")
+          steps = runs.get("steps")
+          if not isinstance(steps, list) or not steps:
+              errors.append("runs.steps must be a non-empty list")
+          else:
+              for i, step in enumerate(steps):
+                  if "run" in step and "shell" not in step:
+                      errors.append(f"steps[{i}] has 'run' but no 'shell'")
+
+          for name, spec in (doc.get("inputs") or {}).items():
+              if spec.get("required") and "default" in spec:
+                  errors.append(f"input '{name}' is required but also sets a default")
+
+          if errors:
+              print("action.yml validation failed:", file=sys.stderr)
+              for e in errors:
+                  print(f"  - {e}", file=sys.stderr)
+              sys.exit(1)
+          print("action.yml: OK ({} inputs, {} outputs, {} steps)".format(
+              len(doc.get("inputs") or {}), len(doc.get("outputs") or {}), len(steps)))
+          PY
+
+  shellcheck:
+    runs-on: ubuntu-latest
+    steps:
+      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
+      - name: "Extract run: blocks from action.yml"
+        run: |
+          set -euo pipefail
+          mkdir -p "$RUNNER_TEMP/action-scripts"
+          count=$(yq '.runs.steps | length' action.yml)
+          for i in $(seq 0 $((count - 1))); do
+            shell=$(yq -r ".runs.steps[$i].shell // \\"\\"" action.yml)
+            script=$(yq -r ".runs.steps[$i].run // \\"\\"" action.yml)
+            [ -z "$script" ] && continue
+            if [ "$shell" != "bash" ]; then
+              echo "::error::step $i uses shell '$shell', expected 'bash' (shellcheck extraction assumes bash)"
+              exit 1
+            fi
+            name=$(yq -r ".runs.steps[$i].name // \\"step-$i\\"" action.yml)
+            slug=$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '-')
+            out="$RUNNER_TEMP/action-scripts/\${i}-\${slug}.sh"
+            {
+              echo "#!/usr/bin/env bash"
+              printf '%s\\n' "$script"
+            } > "$out"
+          done
+          ls -la "$RUNNER_TEMP/action-scripts"
+      - name: shellcheck
+        run: |
+          set -euo pipefail
+          shopt -s nullglob
+          scripts=("$RUNNER_TEMP"/action-scripts/*.sh)
+          if [ "\${#scripts[@]}" -eq 0 ]; then
+            echo "::error::no run: blocks extracted from action.yml"
+            exit 1
+          fi
+          # SC1091: the install step sources ~/.cargo/env, a file that only
+          # exists after rustup runs earlier in that same script. Nothing to
+          # follow at lint time; not a real finding.
+          shellcheck --shell=bash --exclude=SC1091 "\${scripts[@]}"
+
+  # The action has three composite steps: "Validate inputs", "Install
+  # postil" (fetch + cosign-verify the pinned CLI, or build from source),
+  # and "Review" (the actual LLM call). They are not separable via \`uses:\`
+  # since this is a single composite action with unconditional steps, and
+  # calling the action end-to-end would run the "Review" step for real.
+  #
+  # In a workflow triggered by \`pull_request\`, github.event.pull_request.number
+  # is always populated, so \`Review\` would resolve a PR number regardless of
+  # the \`pr\` input and go on to call the configured model endpoint with
+  # whatever \`api-key\` we pass. There is no input combination that reliably
+  # stops the action before that network call on every trigger this workflow
+  # runs on. So instead of invoking the action itself, this job replicates
+  # its install/verify path (same commands, same cosign-verifier invocation)
+  # and stops there, before anything that would need an LLM API key.
+  smoke-install:
+    runs-on: ubuntu-latest
+    permissions:
+      contents: read
+    steps:
+      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
+      - uses: sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4.1.2
+      - name: Fetch, cosign-verify, and run the pinned CLI release
+        env:
+          CLI_REF: 87f4bf08b63712d3600030a7c458f0b790cfc0d5 # postil-cli v0.1.1
+          CLI_RELEASE: v0.1.1
+        run: |
+          set -euo pipefail
+          DEST="$RUNNER_TEMP/postil-bin"
+          mkdir -p "$DEST"
+          target="x86_64-unknown-linux-gnu"
+          base="https://github.com/postil-dev/postil-cli/releases/download/$CLI_RELEASE"
+
+          curl -fsSL -o "$DEST/postil.tar.gz" "$base/postil-$target.tar.gz"
+          curl -fsSL -o "$DEST/postil.tar.gz.sha256" "$base/postil-$target.tar.gz.sha256"
+          curl -fsSL -o "$DEST/postil.tar.gz.sig" "$base/postil-$target.tar.gz.sig"
+          curl -fsSL -o "$DEST/postil.tar.gz.pem" "$base/postil-$target.tar.gz.pem"
+
+          expected=$(awk '{print $1}' "$DEST/postil.tar.gz.sha256")
+          actual=$(sha256sum "$DEST/postil.tar.gz" | awk '{print $1}')
+          [ "$expected" = "$actual" ]
+
+          cosign verify-blob \\
+            "$DEST/postil.tar.gz" \\
+            --signature "$DEST/postil.tar.gz.sig" \\
+            --certificate "$DEST/postil.tar.gz.pem" \\
+            --certificate-identity-regexp 'https://github.com/postil-dev/postil-cli/\\.github/workflows/release\\.yml@refs/tags/.*' \\
+            --certificate-oidc-issuer https://token.actions.githubusercontent.com
+
+          tar -xzf "$DEST/postil.tar.gz" -C "$DEST"
+          chmod +x "$DEST/postil"
+          "$DEST/postil" --version
+
+          # Boundary: this is as far as the smoke test goes. The action's
+          # "Review" step, deliberately not exercised here, takes it from
+          # here to \`postil review --repo ... --pr ...\`, which needs a real
+          # PR and a working model API key.`;

const MIGRATION_ORDERING_ESCALATION_DIFF = `diff --git a/fly.toml b/fly.toml
--- a/fly.toml
+++ b/fly.toml
@@ -12,7 +12,14 @@
 # Browser PostHog also needs NEXT_PUBLIC_POSTHOG_KEY as a Docker build arg.
 # The GitHub Actions deploy workflow passes it from repo variables.
 #
-# Migrations: fly ssh console -C "bun run db:migrate"
+# Migrations run automatically via [deploy].release_command below: Fly runs
+# it as a one-off machine from the new image, with the app's env/secrets
+# (including DATABASE_URL), before any existing machine is updated. A
+# non-zero exit aborts the deploy, so code that depends on a migration can
+# no longer ship ahead of it. \`drizzle-kit\` and the \`drizzle/\` migrations
+# folder ship in the runtime image (full node_modules incl. devDependencies,
+# full repo via \`COPY . .\` in the Dockerfile), so no image changes were
+# needed. For a one-off manual run: fly ssh console -C "bun run db:migrate"
\x20
 app = "postil-web"
 primary_region = "lhr"
@@ -23,6 +30,9 @@ primary_region = "lhr"
 POSTIL_CLI_REV = "v0.1.1"
 NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com"
\x20
+[deploy]
+release_command = "bun run db:migrate"
+
 [processes]
 web = "bun run start"
 worker = "bun run worker"`;

const SILENT_CUTOVER_DIFF = `diff --git a/.env.example b/.env.example
--- a/.env.example
+++ b/.env.example
@@ -72,11 +72,11 @@ POSTIL_BIN=/usr/local/bin/postil
 WORKER_CONCURRENCY=4
 # Initial idle poll interval (default 1000).
 WORKER_POLL_INTERVAL_MS=1000
-# Maximum idle poll interval. For Neon Free, use 900000 (15 minutes) with
-# WORKER_CONCURRENCY=1 so the database has real scale-to-zero windows.
+# Maximum idle poll interval. On free-tier managed Postgres, use 900000
+# (15 minutes) with WORKER_CONCURRENCY=1 so idle periods stay quiet.
 WORKER_IDLE_POLL_MAX_MS=900000
 # Watchdog cadence. Keep it aligned with the idle max poll for free-tier
-# serverless Postgres; lower values intentionally keep the database warmer.
+# managed Postgres; lower values intentionally keep the database warmer.
 WORKER_WATCHDOG_INTERVAL_MS=900000
 # Directory for transient baseline files (default .cache).
 POSTIL_CACHE_DIR=.cache
diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -63,15 +63,27 @@ jobs:
           tar -xzf "\${tmp}/\${art}" -C "$tmp" postil
           install -m 0755 "\${tmp}/postil" vendor/postil
       - uses: superfly/flyctl-actions/setup-flyctl@ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1 # v1.4
-      - name: Stage observability runtime secrets
+      - name: Stage runtime secrets
         run: |
           set -euo pipefail
+          mkdir -p .cache
+          secrets_file=".cache/fly-runtime-secrets.env"
+          : > "\${secrets_file}"
+          chmod 0600 "\${secrets_file}"
+          trap 'rm -f "\${secrets_file}"' EXIT
           token="\${POSTHOG_PROJECT_TOKEN:-\${NEXT_PUBLIC_POSTHOG_KEY:-}}"
           if [[ -n "\${token}" ]]; then
-            printf 'POSTHOG_PROJECT_TOKEN=%s\\n' "\${token}" | flyctl secrets import --stage
+            printf 'POSTHOG_PROJECT_TOKEN=%s\\n' "\${token}" >> "\${secrets_file}"
+          fi
+          if [[ -n "\${DATABASE_URL}" ]]; then
+            printf 'DATABASE_URL=%s\\n' "\${DATABASE_URL}" >> "\${secrets_file}"
+          fi
+          if [[ -s "\${secrets_file}" ]]; then
+            flyctl secrets import --stage < "\${secrets_file}"
           fi
         env:
           FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}
+          DATABASE_URL: \${{ secrets.DATABASE_URL }}
           POSTHOG_PROJECT_TOKEN: \${{ secrets.POSTHOG_PROJECT_TOKEN }}
           NEXT_PUBLIC_POSTHOG_KEY: \${{ vars.NEXT_PUBLIC_POSTHOG_KEY }}
       - run: |
diff --git a/ARCHITECTURE.md b/ARCHITECTURE.md
--- a/ARCHITECTURE.md
+++ b/ARCHITECTURE.md
@@ -11,7 +11,7 @@
\x20
 ## Database
\x20
-Postil is PostgreSQL-native. The hosted control plane uses enums, \`jsonb\`, \`bytea\`, identity columns, and row-lock queue claims. Neon Free and Supabase Free are viable because they preserve PostgreSQL compatibility. Cloudflare D1, Turso/libSQL, and other SQLite-style services are not drop-in replacements; adopting them requires a schema and queue rewrite.
+Postil is PostgreSQL-native. The hosted control plane runs on Supabase Free Postgres through the Supabase connection pooler and uses enums, \`jsonb\`, \`bytea\`, identity columns, and row-lock queue claims. Cloudflare D1, Turso/libSQL, and other SQLite-style services are not drop-in replacements; adopting them requires a schema and queue rewrite.
\x20
 The free-tier operating profile keeps Postgres idle-capable by avoiding permanent hot polling. Webhook intake enqueues work and can trigger a bounded web-process drain. The worker remains a fallback with configurable idle backoff.
\x20
diff --git a/src/app/docs/self-hosted/page.tsx b/src/app/docs/self-hosted/page.tsx
--- a/src/app/docs/self-hosted/page.tsx
+++ b/src/app/docs/self-hosted/page.tsx
@@ -88,14 +88,13 @@ docker compose exec web bun run db:migrate\`}</code>
         replacements for the hosted control plane.
       </p>
       <p>
-        For a free-tier managed Postgres, use either Neon Free or Supabase Free
-        with the low-idle queue profile in <code>.env.example</code>. Webhooks
-        kick a bounded web-process queue drain, while the worker stays as a
-        slow fallback. On Neon Free, set <code>WORKER_CONCURRENCY=1</code> and{" "}
-        <code>WORKER_IDLE_POLL_MAX_MS=900000</code> and{" "}
-        <code>WORKER_WATCHDOG_INTERVAL_MS=900000</code> so the database gets
-        real scale-to-zero windows instead of a query every few seconds
-        forever.
+        For a free-tier managed Postgres, Supabase Free works with the
+        low-idle queue profile in <code>.env.example</code>. Webhooks kick a
+        bounded web-process queue drain, while the worker stays as a slow
+        fallback. Set <code>WORKER_CONCURRENCY=1</code>,{" "}
+        <code>WORKER_IDLE_POLL_MAX_MS=900000</code>, and{" "}
+        <code>WORKER_WATCHDOG_INTERVAL_MS=900000</code> so idle periods stay
+        quiet instead of issuing database checks every few seconds forever.
       </p>
\x20
       <h3>Required configuration</h3>
diff --git a/src/app/privacy/page.tsx b/src/app/privacy/page.tsx
--- a/src/app/privacy/page.tsx
+++ b/src/app/privacy/page.tsx
@@ -101,9 +101,8 @@ export default function PrivacyPage() {
             plane and the review worker.
           </li>
           <li>
-            <strong>Managed PostgreSQL</strong> — Neon or another Postgres
-            provider: stores accounts,
-            installations, and review envelopes.
+            <strong>Supabase Postgres</strong> — managed PostgreSQL storage for
+            accounts, installations, and review envelopes.
           </li>
           <li>
             <strong>PostHog</strong> — privacy-scoped analytics: stores`;

export const EVIDENCE_CASES: EvidenceCase[] = [
  {
    id: "migration-dedup",
    category: "Migration safety",
    title: "A unique index that would fail against production duplicates",
    blurb:
      "A migration adds a unique index to close a race condition the PR is fixing. The race could already have produced duplicate rows that make the new index fail.",
    diff: MIGRATION_DEDUP_DIFF,
    diffIsExcerpt: true,
    sourceUrl: "https://github.com/postil-dev/postil/pull/275",
    reviewUrl:
      "https://github.com/postil-dev/postil/pull/275#pullrequestreview-4614383953",
    checkRunUrl: "https://github.com/postil-dev/postil/runs/84687183194",
    gateCheckRunUrl: "https://github.com/postil-dev/postil/runs/84687183816",
    commitSha: "4d08309409e3b250cca5db5f53527e39a3a71ef9",
    envelope: {
      checkRunTitle: "1 error, 0 warn, 0 info",
      summary:
        'The migration adding a unique index on organizations.github_org_id risks failing in production if duplicate rows already exist from the pre-fix race condition. Verify the production dataset is clean or add a deduplication step before the CREATE UNIQUE INDEX.\n\n- <img src="https://postil.dev/status/error.svg" width="14" height="14" alt="error" align="text-bottom"> **error** `drizzle/0001_org_indexes_and_constraints.sql:3` — Add deduplication before unique index migration · confidence 0.85 · kind: risk\n\nModel: moonshotai/kimi-k2.6',
      silent: false,
      findings: [
        {
          path: "drizzle/0001_org_indexes_and_constraints.sql",
          line: 3,
          endLine: 3,
          severity: "error",
          kind: "risk",
          confidence: 0.85,
          title: "Add deduplication before unique index migration",
          body: "The new `CREATE UNIQUE INDEX` on `organizations.github_org_id` will fail if the database already contains duplicate non-null values. The PR description explicitly states that concurrent installation webhooks could have created duplicate organization rows for the same GitHub org before this fix. Run `SELECT github_org_id, COUNT(*) FROM organizations WHERE github_org_id IS NOT NULL GROUP BY github_org_id HAVING COUNT(*) > 1;` against the production database; if any rows are returned, merge the duplicates and update referencing foreign keys before this migration is applied.",
        },
      ],
      gate: {
        title: "1 error, 0 warn, 0 info",
        summary:
          "Gate failing at `error` on:\n- `drizzle/0001_org_indexes_and_constraints.sql:3` Add deduplication before unique index migration",
        failOn: "error",
        failing: true,
      },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "swapped-shas",
    category: "Docs / CI",
    title: "Two repositories’ commit SHAs swapped in copied examples",
    blurb:
      "Two documentation snippets pin cli-ref to the action repository commit instead of the separate CLI repository commit. Both real annotations are preserved below.",
    diff: SWAPPED_SHAS_DIFF,
    diffIsExcerpt: true,
    sourceUrl: "https://github.com/postil-dev/postil/pull/280",
    reviewUrl:
      "https://github.com/postil-dev/postil/pull/280#pullrequestreview-4617737950",
    checkRunUrl: "https://github.com/postil-dev/postil/runs/84779432874",
    gateCheckRunUrl: "https://github.com/postil-dev/postil/runs/84779434442",
    commitSha: "e625962b8890569c3eed4b48f893f7a5de43b60b",
    envelope: {
      checkRunTitle: "2 error, 0 warn, 0 info",
      summary:
        'The quickstart and docs index snippets incorrectly change `cli-ref` from the CLI repository\'s SHA to the action repository\'s SHA; users who copy them will get a CLI resolution failure in CI.\n\n- <img src="https://postil.dev/status/error.svg" width="14" height="14" alt="error" align="text-bottom"> **error** `src/app/docs/quickstart/page.tsx:71` — Fix cli-ref to use CLI repository SHA · confidence 0.90 · kind: risk\n- <img src="https://postil.dev/status/error.svg" width="14" height="14" alt="error" align="text-bottom"> **error** `src/app/docs/page.tsx:92` — Fix cli-ref to use CLI repository SHA · confidence 0.90 · kind: risk\n\nModel: moonshotai/kimi-k2.6',
      silent: false,
      findings: [
        {
          path: "src/app/docs/quickstart/page.tsx",
          line: 71,
          endLine: 71,
          severity: "error",
          kind: "risk",
          confidence: 0.9,
          title: "Fix cli-ref to use CLI repository SHA",
          body: "`cli-ref` was changed from the CLI commit `87f4bf08b63712d3600030a7c458f0b790cfc0d5` to the action commit `0d92d604e753fd6831baeeff85e3f2ff4a84bd6c`. Because `cli-ref` resolves against the `postil-cli` repository (per the surrounding docs), pinning it to the action repo's SHA will cause the composite action to fail when installing the CLI. Revert `cli-ref` to the current `postil-cli` HEAD or latest SHA, updating only the action `uses` pin.",
        },
        {
          path: "src/app/docs/page.tsx",
          line: 92,
          endLine: 92,
          severity: "error",
          kind: "risk",
          confidence: 0.9,
          title: "Fix cli-ref to use CLI repository SHA",
          body: "`cli-ref` was changed from the CLI commit `87f4bf08b63712d3600030a7c458f0b790cfc0d5` to the action commit `0d92d604e753fd6831baeeff85e3f2ff4a84bd6c`. Because `cli-ref` resolves against the `postil-cli` repository (per the surrounding docs), pinning it to the action repo's SHA will cause the composite action to fail when installing the CLI. Revert `cli-ref` to the current `postil-cli` HEAD or latest SHA, updating only the action `uses` pin.",
        },
      ],
      gate: {
        title: "2 error, 0 warn, 0 info",
        summary:
          "Gate failing at `error` on:\n- `src/app/docs/quickstart/page.tsx:71` Fix cli-ref to use CLI repository SHA\n- `src/app/docs/page.tsx:92` Fix cli-ref to use CLI repository SHA",
        failOn: "error",
        failing: true,
      },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "utf8-panic",
    category: "Correctness",
    title: "A byte-slice panic on non-ASCII input",
    blurb:
      "The review at this head commit caught a byte offset used without first aligning to a UTF-8 character boundary. The displayed excerpt is the named head commit’s own src/diff.rs patch.",
    diff: UTF8_PANIC_DIFF,
    diffIsExcerpt: true,
    sourceUrl: "https://github.com/postil-dev/postil-cli/pull/25",
    reviewUrl:
      "https://github.com/postil-dev/postil-cli/pull/25#pullrequestreview-4617891804",
    checkRunUrl: "https://github.com/postil-dev/postil-cli/runs/84783338711",
    gateCheckRunUrl:
      "https://github.com/postil-dev/postil-cli/runs/84783340480",
    commitSha: "75af97afed7a4953111aec8d5d7c0f1bd9f1369b",
    envelope: {
      checkRunTitle: "1 error, 0 warn, 0 info",
      summary:
        'The new `cap_raw_diff` helper can panic when `MAX_RAW_DIFF_BYTES` lands inside a multi-byte UTF-8 character, because `&str[..max_bytes]` requires a char boundary. This aborts the review on large diffs containing non-ASCII file content instead of truncating safely.\n\n- <img src="https://postil.dev/status/error.svg" width="14" height="14" alt="error" align="text-bottom"> **error** `src/diff.rs:127` — Panic in raw-diff cap on non-ASCII input · confidence 0.95 · kind: risk\n\nModel: moonshotai/kimi-k2.6',
      silent: false,
      findings: [
        {
          path: "src/diff.rs",
          line: 127,
          endLine: 127,
          severity: "error",
          kind: "risk",
          confidence: 0.95,
          title: "Panic in raw-diff cap on non-ASCII input",
          body: "`text[..max_bytes]` at line 127 will panic if the byte cap falls inside a multi-byte UTF-8 character, because `str` slicing requires char boundaries. Diff text can contain arbitrary file content (e.g., emoji, CJK), so a large diff that exceeds `MAX_RAW_DIFF_BYTES` will crash the review process instead of truncating. Move the char-boundary alignment (the `while b > 0 && !text.is_char_boundary(b)` loop currently inside the `unwrap_or_else`) to run **before** the `rfind`, or use `text.get(..max_bytes)` to obtain a safe prefix slice first.",
        },
      ],
      gate: {
        title: "1 error, 0 warn, 0 info",
        summary:
          "Gate failing at `error` on:\n- `src/diff.rs:127` Panic in raw-diff cap on non-ASCII input",
        failOn: "error",
        failing: true,
      },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "yq-not-installed",
    category: "CI",
    title: "A CI job with an undeclared tool dependency",
    blurb:
      "A new self-test workflow calls yq without installing it. The full one-file commit patch and the exact annotation explain the resulting failure mode.",
    diff: YQ_NOT_INSTALLED_DIFF,
    diffIsExcerpt: false,
    sourceUrl: "https://github.com/postil-dev/postil-action/pull/4",
    reviewUrl:
      "https://github.com/postil-dev/postil-action/pull/4#pullrequestreview-4617538183",
    checkRunUrl: "https://github.com/postil-dev/postil-action/runs/84774720207",
    gateCheckRunUrl:
      "https://github.com/postil-dev/postil-action/runs/84774721985",
    commitSha: "c631af1d1cf7b32fbf73830a9b564420545b9054",
    envelope: {
      checkRunTitle: "1 error, 0 warn, 0 info",
      summary:
        'The shellcheck CI job invokes `yq` without installing it, so the workflow will fail on `ubuntu-latest` runners where `yq` is not present by default.\n\n- <img src="https://postil.dev/status/error.svg" width="14" height="14" alt="error" align="text-bottom"> **error** `.github/workflows/ci.yml:83` — shellcheck job uses yq but never installs it · confidence 0.90 · kind: risk\n\nModel: moonshotai/kimi-k2.6',
      silent: false,
      findings: [
        {
          path: ".github/workflows/ci.yml",
          line: 83,
          endLine: 83,
          severity: "error",
          kind: "risk",
          confidence: 0.9,
          title: "shellcheck job uses yq but never installs it",
          body: 'The `shellcheck` job calls `yq` on lines 83, 85, 86, and 92 to extract run blocks from `action.yml`, but `ubuntu-latest` GitHub-hosted runners do not include `yq` by default. Because the command substitutions happen inside variable assignments, `set -e` will not catch the missing command immediately; the job will eventually fail with "no run: blocks extracted from action.yml". Add an explicit step to install a pinned version of `yq` (for example, via the `mikefarah/yq` action or by downloading the release binary and verifying its checksum) before the extraction step.',
        },
      ],
      gate: {
        title: "1 error, 0 warn, 0 info",
        summary:
          "Gate failing at `error` on:\n- `.github/workflows/ci.yml:83` shellcheck job uses yq but never installs it",
        failOn: "error",
        failing: true,
      },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "migration-ordering-escalation",
    category: "Deploy",
    title: "A deployment-ordering risk escalated for human confirmation",
    blurb:
      "The Fly release command runs migrations before new machines start while old processes remain active. The review asks an owner to verify backward compatibility rather than guessing.",
    diff: MIGRATION_ORDERING_ESCALATION_DIFF,
    diffIsExcerpt: false,
    sourceUrl: "https://github.com/postil-dev/postil/pull/279",
    reviewUrl:
      "https://github.com/postil-dev/postil/pull/279#pullrequestreview-4617700162",
    checkRunUrl: "https://github.com/postil-dev/postil/runs/84778576695",
    gateCheckRunUrl: "https://github.com/postil-dev/postil/runs/84778578169",
    commitSha: "c46a13f8056821ea96fe852afb8f8a43fbe03ad4",
    envelope: {
      checkRunTitle: "0 error, 1 warn, 0 info",
      summary:
        'The new [deploy] release_command runs migrations automatically before new machines start, but while old web and worker instances remain active. If pending migrations are not backward-compatible with the currently deployed code, running instances may error during the deploy window.\n\n- <img src="https://postil.dev/status/warn.svg" width="14" height="14" alt="warn" align="text-bottom"> **warn** `fly.toml:33` — Confirm automatic migration deploy ordering with owner · confidence 0.90 · kind: humanEscalation\n\nModel: moonshotai/kimi-k2.6',
      silent: false,
      findings: [
        {
          path: "fly.toml",
          line: 33,
          endLine: 33,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.9,
          title: "Confirm automatic migration deploy ordering with owner",
          body: "The `[deploy]` section runs `bun run db:migrate` as a one-off machine before any existing machine is updated, but old web and worker processes continue serving traffic during the migration. If a pending migration acquires long-lived exclusive locks or is not backward-compatible with the currently deployed code (e.g., drops a column, renames a table), active instances may 500 or deadlock until the migration completes and new machines start. Before merging, inspect the `drizzle/` folder for any pending migrations that are destructive or long-running, and verify they are safe to apply while the current production code is still active. If not, make them backward-compatible first or plan a maintenance window.",
        },
      ],
      gate: {
        title: "0 error, 1 warn, 0 info",
        summary: "Gate (`failOn: error`) passing.",
        failOn: "error",
        failing: false,
      },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
  {
    id: "silent-cutover",
    category: "Clean",
    title: "A production database cutover, passed in silence",
    blurb:
      "The hosted control plane's Postgres moves to Supabase: deploy-workflow secret staging, worker profile docs, architecture, and the privacy page. postil/review ran on the head commit and posted nothing: the pull request has no postil comment or review at all. A finding-free review leaves no noise on the PR; the check-run is the only trace.",
    diff: SILENT_CUTOVER_DIFF,
    diffIsExcerpt: false,
    sourceUrl: "https://github.com/postil-dev/postil/pull/295",
    checkRunUrl: "https://github.com/postil-dev/postil/runs/85632156582",
    gateCheckRunUrl: "https://github.com/postil-dev/postil/runs/85632158370",
    commitSha: "5976fccf72ef93dbf5b175482fac1c79cb9890f2",
    envelope: {
      checkRunTitle: "No merge-relevant findings",
      summary:
        '<img src="https://postil.dev/status/pass.svg" width="14" height="14" alt="pass" align="text-bottom"> Postil reviewed this change and found nothing that affects the merge decision.\n\nModel: moonshotai/kimi-k2.6',
      silent: true,
      findings: [],
      gate: {
        title: "No merge-relevant findings",
        summary: "Gate (`failOn: error`) passing.",
        failOn: "error",
        failing: false,
      },
      modelUsed: "moonshotai/kimi-k2.6",
    },
  },
];
