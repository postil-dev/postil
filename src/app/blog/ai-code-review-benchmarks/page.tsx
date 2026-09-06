import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { BENCH } from "@/components/bench-table";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("ai-code-review-benchmarks");
export const metadata = blogPostMetadata(post);

export default function BenchmarksArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd(post)) }} />
      <BlogArticleHeader post={post} />
      <div className="prose-postil blog-prose mt-10">
        <p>
          A model can point at the right line, explain the wrong defect, and receive a detection point.
          That is possible in Postil&apos;s screening benchmark because its detection rule checks location.
          A useful comparison needs to say what earns a point before it compares percentages.
        </p>
        <h2>What is a test case?</h2>
        <p>
          The <Link href="/bench">published Postil screening report</Link> covers
          {" "}{BENCH.defectCases} changes with authored defects and {BENCH.cleanCases} changes labeled clean.
          A fixture is a prepared code or documentation change with an expected result.
          A defect fixture names the faulty file and line range. A clean fixture expects no finding.
          These labels define the scoring targets; they are not measurements of how often real pull requests contain bugs.
        </p>
        <p>
          The <a href="https://github.com/postil-dev/postil-cli/tree/main/bench#readme">public fixture suite</a>
          {" "}includes a defect case that changes <code>Math.floor(ttlMs / 1000)</code> to
          {" "}<code>ttlMs</code> in a function returning cache-expiry seconds. It makes a millisecond
          input a thousand times too large for that contract. A paired clean case only renames the
          local variable and preserves the conversion. Other clean cases clarify a source comment
          or rename a type without changing behavior. These examples test whether a reviewer invents a
          defect in a harmless change. They do not establish its behavior on an unfamiliar algorithm,
          a large refactor or a repository with different conventions. Valid reviews with no findings
          on this curated sample cannot establish a false-positive rate for production changes.
        </p>
        <h2>A clean label needs a contract</h2>
        <p>
          The separate <a href="/bench/screening-0.9.7-clean-bank-v2.json">25-case clean bank</a> adds 12 executable
          application examples to the historical 13 clean cases. One rewrites
          {" "}<code>now &gt;= entry.expiresAt</code> as <code>entry.expiresAt &lt;= now</code> while
          preserving the missing-entry check. Its contract says timestamps are finite milliseconds
          and an entry expires at equality. Those constraints make the two forms equivalent.
          The clean label rests on that behavior, not on how small the edit looks.
        </p>
        <p>
          With Luna on Azure EU and GLM on Z.AI, Postil produces 25 valid final reviews with no
          findings per model in one matched run over that bank. Final reviews with findings and
          unavailable results are both zero. Silence measures the output after Postil&apos;s finding
          suppression; it does not imply that a model generated no candidate findings.
          These clean-only results use a different corpus and binary from the 70-case report.
          They extend the tested examples; they supply neither a defect-detection score nor a
          population estimate of false alarms.
        </p>
        <h2>Location, explanation and gate decision</h2>
        <p>
          In the <a href="/bench/screening-0.8.26-case-evidence.json">configuration-loader example</a>,
          the change replaces a default return with a throw, beside a comment promising fallback.
          GLM&apos;s first finding identifies the false comment and offers changing that comment as
          one remedy and restoring the default return as another. Only the latter changes runtime
          behavior, but the location score does not evaluate the proposed remedies. The finding
          receives detection credit because it points at the target line.
          GLM also reports the lost fallback in a second finding; the location score credits only one.
        </p>
        <p>
          Gate correctness tests a separate decision. In the same evidence file, both models detect
          a disabled request timeout and label it an error. The fixture labels that defect a warning,
          so its expected error-only gate passes. A defect can therefore count as detected while its
          gate decision disagrees with the authored policy. A blocking defect is one that policy
          requires the gate to reject; the defect label alone does not imply that requirement.
        </p>
        <dl>
          <dt><strong>Detection</strong></dt>
          <dd>The fraction of all {BENCH.defectCases} defect fixtures with a finding that overlaps the target path and line range. A case without a usable review cannot earn a detection point. The score does not verify the explanation.</dd>
          <dt><strong>Clean-case silence</strong></dt>
          <dd>The fraction of all {BENCH.cleanCases} clean fixtures with a usable final Postil review containing no findings. A failed review does not count as silence; a retained warning counts against silence even when the gate succeeds. Suppressed candidates are separate from final findings.</dd>
          <dt><strong>Gate correctness</strong></dt>
          <dd>The fraction of cases with a scored gate verdict whose pass or fail decision matches the fixture&apos;s expected decision. Cases without a usable review result are unscored and excluded from this denominator.</dd>
        </dl>
        <p>
          Excluding failed outputs can make a gate percentage look better than review availability.
          A model that returns no usable result has not approved the change correctly, even though
          that case contributes neither a correct nor an incorrect gate verdict to this percentage.
          The report therefore lists unscored cases beside gate correctness, and charges and latency
          must be read with the output failures in view.
        </p>
        <h2>Why other benchmarks produce different percentages</h2>
        <p>
          <a href="https://www.greptile.com/benchmarks">Greptile&apos;s benchmark methodology</a>
          {" "}uses 50 pull requests that reintroduce known bugs. A catch requires a line-level comment
          that identifies the faulty code and explains its impact. False positives and unrelated
          comments do not reduce that catch rate. This tests more than Postil&apos;s location match,
          but the catch rate alone still does not measure review noise.
        </p>
        <p>
          <a href="https://arxiv.org/abs/2509.01494v2">SWR-Bench</a> provides 1,000 manually verified
          pull requests with project context. Its evaluator uses an LLM to assess whether generated
          reviews cover issues in structured ground truth. That introduces a judgment about the
          explanation which a path-and-line matcher does not make. The different inputs and scoring
          rules prevent these studies&apos; percentages from forming a common leaderboard.
        </p>
        <p>
          Postil&apos;s <Link href="/bench#run-the-suite">suite instructions</Link> distinguish an offline
          mock run, which checks the harness against prepared responses, from a live model run,
          which measures generated reviews and incurs provider charges. The
          {" "}<a href="/bench/postil-model-bench.json">screening report</a> identifies the CLI binary,
          corpus and evaluator by hashes. Those identify the experiment behind the figures;
          running a different binary or corpus does not reproduce the same measurement.
        </p>
      </div>
    </div>
  );
}
