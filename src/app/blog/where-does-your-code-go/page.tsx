import Link from "next/link";

import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("where-does-your-code-go");
export const metadata = blogPostMetadata(post);
const articleJsonLd = blogPostJsonLd(post);

export default function WhereDoesYourCodeGoArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <BlogArticleHeader post={post} />

      <div className="prose-postil blog-prose mt-10">
        <p>
          To review a pull request, a tool has to read the diff, and often the
          surrounding files. That is unavoidable. What is not fixed is what
          happens next: whether your code is held on the vendor&apos;s servers
          after the review, whether it is used to train or improve a model, and
          whose infrastructure the inference call runs on. Those three
          questions, retention, training, and inference location, are what a
          security review of an AI reviewer actually turns on, and they vary far
          more between products than catch rates do.
        </p>
        <p>
          This is a comparative explainer, not a scorecard. It groups the tools
          by how they handle code rather than ranking them, states each
          vendor&apos;s posture with source links, and ends with the questions to
          put to any vendor, including us. For
          Postil&apos;s own controls, structural detail lives on the{" "}
          <Link href="/security">security page</Link>; this piece is about the
          category, so we keep our part short and point there.
        </p>

        <h2>Why this is the question procurement asks first</h2>
        <p>
          Security functions as a procurement gate. As one CTO checklist circulating
          in 2026 puts it, &quot;a tool scoring 0 or 1 on security will not
          survive procurement regardless of its capabilities elsewhere&quot; (
          <a
            href="https://www.augmentcode.com/guides/cto-ai-coding-checklist"
            rel="noopener"
          >
            Augment CTO checklist
          </a>
          ). The category also has a concrete reason for the scrutiny. In an
          August 2025 disclosure, security researchers at Kudelski described
          achieving{" "}
          <a
            href="https://research.kudelskisecurity.com/2025/08/19/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories/"
            rel="noopener"
          >
            remote code execution inside CodeRabbit&apos;s review pipeline
          </a>{" "}
          via a malicious linter config in a pull request, exfiltrating
          environment variables that included a GitHub App private key carrying
          write access across roughly a million repositories (
          <a href="https://news.ycombinator.com/item?id=44953032" rel="noopener">
            HN discussion
          </a>
          ). CodeRabbit reported the issue fixed; the durable lesson is not about
          one vendor but about blast radius. The same incident drove a search
          pattern around whether CodeRabbit is safe. People are asking, and the
          honest answer requires reading the data-flow, not the marketing page.
        </p>

        <h2>Three questions that decide everything</h2>
        <p>
          Strip away the feature lists and an AI reviewer&apos;s data posture
          reduces to three independent questions:
        </p>
        <ul>
          <li>
            <strong>Retention.</strong> After a review finishes, does your source
            (or an embedding of it) persist on the vendor&apos;s servers, and for
            how long? Ephemeral-then-deleted, a few-day troubleshooting window,
            and indefinite storage are three very different answers.
          </li>
          <li>
            <strong>Training.</strong> Is your code, or telemetry derived from
            it, used to train or improve a model? If so, is that on by default
            with an opt-out, or off unless you opt in?
          </li>
          <li>
            <strong>Inference location.</strong> Whose account makes the call to
            the model, and under whose data-processing agreement? A vendor
            calling its own model account is a different exposure from a tool
            that calls a model endpoint you control under your own contract.
          </li>
        </ul>
        <p>
          A tool can be excellent on one and weak on another. Greptile, for
          example, has a genuine self-hosted, air-gapped deployment for
          enterprise buyers and a default hosted posture that is the most
          retentive among the majors. The questions are orthogonal, so audit
          them separately.
        </p>

        <h2>The hosted majors, by stated posture</h2>
        <p>
          What follows is each vendor&apos;s own published position for its default
          hosted product. Postures change; re-verify against the linked page
          and, for anything that matters, the contract rather than the marketing
          copy. Enterprise tiers often differ from defaults, which is exactly
          why the default is worth stating.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Code retention (default hosted)</th>
              <th scope="col" className="hidden sm:table-cell">
                Training on your code
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>CodeRabbit</td>
              <td>Ephemeral review environments; SOC 2 Type II</td>
              <td className="hidden sm:table-cell">
                States it does not train on your code
              </td>
            </tr>
            <tr>
              <td>Qodo</td>
              <td>
                Zero-retention model account; troubleshooting data deleted within
                48 hours
              </td>
              <td className="hidden sm:table-cell">
                Zero-retention posture; SOC 2 Type II
              </td>
            </tr>
            <tr>
              <td>Greptile</td>
              <td>
                Stores code and embeddings on its servers until access is revoked
              </td>
              <td className="hidden sm:table-cell">
                May use anonymized customer data for AI improvement unless you
                opt out
              </td>
            </tr>
            <tr>
              <td>GitHub Copilot</td>
              <td>Hosted on GitHub infrastructure</td>
              <td className="hidden sm:table-cell">
                Free/Pro interaction data used for training unless opted out;
                Business/Enterprise excluded
              </td>
            </tr>
            <tr>
              <td>Postil (hosted)</td>
              <td>
                Stores the review envelope only; source code never persisted
              </td>
              <td className="hidden sm:table-cell">
                Hosted default uses Postil&apos;s provider path; hosted BYOK routes
                through the worker to your provider
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          The detail behind each row:
        </p>
        <p>
          <strong>CodeRabbit</strong> publishes SOC 2 Type II compliance,
          describes ephemeral review environments, and states it does not train
          on your code (
          <a href="https://www.coderabbit.ai/trust-center" rel="noopener">
            trust center
          </a>
          ). The August 2025 RCE is a separate matter from its data-retention
          policy; both belong in an audit.
        </p>
        <p>
          <strong>Qodo</strong> describes a zero-retention arrangement with its
          model provider and says troubleshooting data is deleted within 48
          hours, alongside SOC 2 Type II (
          <a
            href="https://www.qodo.ai/blog/qodo-security-our-commitment-to-data-privacy-and-security/"
            rel="noopener"
          >
            Qodo security post
          </a>
          ). Its open-source PR-Agent is a separate path you run yourself, which
          changes the inference-location answer entirely.
        </p>
        <p>
          <strong>Greptile</strong> is the most retentive of the majors by its
          own description: it{" "}
          <a href="https://www.greptile.com/security" rel="noopener">
            states
          </a>{" "}
          that it stores code and embeddings on its servers until you revoke
          access, and that it may use anonymized customer data for AI
          improvement unless you opt out. Both store-by-default and
          train-by-default are present; both are reversible, but the default is
          the opposite of zero-retention. Greptile also offers a self-hosted,
          air-gapped enterprise deployment that sidesteps this entirely, so the
          posture you get depends on the tier you buy.
        </p>
        <p>
          <strong>GitHub Copilot</strong> uses Free, Pro, and Pro+ interaction
          data for training unless you opt out, a policy in effect since April
          24, 2025;
          Business and Enterprise are excluded (
          <a
            href="https://github.blog/news-insights/company-news/updates-to-github-copilot-interaction-data-usage-policy/"
            rel="noopener"
          >
            GitHub policy update
          </a>
          ). For code review specifically this means the training answer depends
          on which Copilot plan the reviewing identity is on.
        </p>

        <h2>The structural variable: where inference runs</h2>
        <p>
          The table above covers retention and training. The third question,
          where the inference call is made, splits the category along a line
          that the marketing rarely draws clearly. In the hosted majors, the
          vendor makes the model call on its own account: your diff goes to the
          vendor, the vendor sends it to a model provider, and you inherit
          whatever data-processing terms the vendor negotiated. That can be a
          perfectly good arrangement, but it is the vendor&apos;s arrangement,
          not yours.
        </p>
        <p>
          The other shape is bring-your-own-key, where the tool sends the diff
          to a provider endpoint selected by the customer, authenticated with
          the customer&apos;s key, under that customer&apos;s data-processing agreement
          with the provider, or to a model the customer hosts. Among the majors
          this is mostly an enterprise or open-source
          path: CodeRabbit allows BYOK only when self-hosted, and
          Qodo&apos;s PR-Agent supports any key, including a local Ollama
          endpoint, because you run it yourself (
          <a href="https://github.com/qodo-ai/pr-agent" rel="noopener">
            PR-Agent
          </a>
          ). Macroscope, hosted Copilot, and Cursor Bugbot do not offer BYOK
          or model selection in their hosted products. The reason inference
          location matters is that it determines which contract governs your
          code in the one place it is most exposed: in transit to, and being
          processed by, a large language model.
        </p>

        <h2>Where Postil sits, stated plainly</h2>
        <p>
          Postil is one option on this map, and here is its data-flow without
          adjectives. CLI and self-hosted deployments send your diff directly to
          the OpenAI-compatible endpoint you configure, OpenRouter, Azure
          OpenAI, vLLM, LiteLLM, or a local Ollama, authenticated with your key.
          Hosted organizations can use the same BYOK model settings; in that
          case, the worker sends the diff to your configured provider and
          region under your provider relationship. Hosted organizations without
          BYOK model settings use Postil&apos;s configured provider credentials, with
          diffs sent from the worker to Postil&apos;s OpenRouter-compatible provider
          path and downstream model providers under Postil&apos;s provider
          relationship.
        </p>
        <p>
          On retention, the hosted control plane persists exactly one artifact
          per review: the envelope, a JSON document with the summary, the
          findings (path, line, severity, confidence, and the finding text),
          token usage, and the gate verdict. The diff is fetched at review time,
          sent through the worker to either Postil&apos;s configured provider path or
          the provider your org configures for BYOK, and discarded with the
          process. There is no code cache, no embedding index, and no repository
          clone on our infrastructure, and a self-hosted deployment sends us
          nothing at all, no telemetry, no license pings, no update checks. When
          a BYOK credential is stored for the hosted product, it is sealed with
          AES-256-GCM before it touches the database and the settings form is
          write-only: a stored key
          can be replaced or removed, never read back out.
        </p>
        <p>
          The GitHub App asks for the smallest permission set that does the job:{" "}
          <code>contents: read</code> to fetch the diff,{" "}
          <code>pull_requests: write</code> to post one batched review,{" "}
          <code>checks: write</code> for the two check-runs, and{" "}
          <code>issues: write</code> for explicit command replies,{" "}
          <code>members: read</code> to verify organization admins before
          recording approvals, and <code>metadata: read</code>. It never requests{" "}
          <code>contents: write</code>, so even a full compromise of an
          installation token cannot push a commit. That is the structural
          counterpart to the RCE lesson above: hold no credential a reviewer does
          not need. None of this is a claim that Postil is safer than any other
          tool; it is a description of one posture, checkable against the{" "}
          <Link href="/security">security page</Link>, the{" "}
          <Link href="/docs/envelope">envelope schema</Link>, and the{" "}
          <Link href="/privacy">privacy policy</Link>, and against the
          open-source CLI directly.
        </p>

        <h2>Questions to ask any vendor (including us)</h2>
        <p>
          A SOC 2 guide making the rounds in 2026 gives the right instinct: get
          written confirmation, and &quot;read the actual MSA, not the marketing
          page&quot; (
          <a
            href="https://www.probo.com/hub/ai-coding-tools-soc2-compliance"
            rel="noopener"
          >
            Probo
          </a>
          ). These are the questions that map to the three variables above:
        </p>
        <ul>
          <li>
            After a review completes, what is retained on your servers, my source
            or only derived metadata, and for how long? Is there a written
            zero-retention or deletion commitment?
          </li>
          <li>
            Do you train or improve any model on my code or on telemetry derived
            from it? Is that off by default, or on with an opt-out, and where is
            the toggle?
          </li>
          <li>
            Whose account makes the model call, and under whose data-processing
            agreement? Can I point inference at an endpoint or model I control?
          </li>
          <li>
            What is the exact GitHub (or GitLab) permission scope, and does it
            include write access to code? If the pipeline were compromised, what
            could an attacker reach?
          </li>
          <li>
            Does the default posture differ from the enterprise tier? Quote me
            the default, since that is what I run on day one.
          </li>
        </ul>
        <p>
          A vendor that can answer these in writing, default first, is one you
          can actually audit. A vendor that can only point at a trust badge is
          asking you to take the data-flow on faith, which, after August 2025, is
          the one thing this category has not earned.
        </p>

        <h2>Sources</h2>
        <ul>
          <li>
            <a
              href="https://research.kudelskisecurity.com/2025/08/19/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories/"
              rel="noopener"
            >
              Kudelski Security: CodeRabbit RCE write-up
            </a>{" "}
            (Aug 19, 2025);{" "}
            <a
              href="https://news.ycombinator.com/item?id=44953032"
              rel="noopener"
            >
              HN discussion
            </a>
          </li>
          <li>
            <a href="https://www.coderabbit.ai/trust-center" rel="noopener">
              CodeRabbit trust center
            </a>{" "}
            (SOC 2 Type II, ephemeral reviews, no training on code)
          </li>
          <li>
            <a
              href="https://www.qodo.ai/blog/qodo-security-our-commitment-to-data-privacy-and-security/"
              rel="noopener"
            >
              Qodo security post
            </a>{" "}
            (zero-retention, 48-hour troubleshooting deletion)
          </li>
          <li>
            <a href="https://www.greptile.com/security" rel="noopener">
              Greptile security page
            </a>{" "}
            (stores code and embeddings until access revoked; anonymized data
            used for AI improvement unless opted out)
          </li>
          <li>
            <a
              href="https://github.blog/news-insights/company-news/updates-to-github-copilot-interaction-data-usage-policy/"
              rel="noopener"
            >
              GitHub: Copilot interaction data usage policy
            </a>{" "}
            (in effect Apr 24, 2025): Free/Pro train unless opted out,
            Business/Enterprise excluded
          </li>
          <li>
            <a href="https://github.com/qodo-ai/pr-agent" rel="noopener">
              Qodo PR-Agent
            </a>{" "}
            (open-source, BYOK including Ollama)
          </li>
          <li>
            <a
              href="https://www.augmentcode.com/guides/cto-ai-coding-checklist"
              rel="noopener"
            >
              Augment: CTO AI coding checklist
            </a>{" "}
            (security as a procurement gate)
          </li>
          <li>
            <a
              href="https://www.probo.com/hub/ai-coding-tools-soc2-compliance"
              rel="noopener"
            >
              Probo: AI coding tools and SOC 2 compliance
            </a>{" "}
            (read the MSA, not the marketing page)
          </li>
          <li>
            Postil controls, verifiable in source: the{" "}
            <Link href="/security">security page</Link>, the{" "}
            <Link href="/docs/envelope">envelope schema</Link>, and the{" "}
            <Link href="/privacy">privacy policy</Link>
          </li>
        </ul>
      </div>

      <div className="rounded-card shadow-card mt-14 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">
            Audit our data-flow yourself.
          </h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Only the review envelope is retained. Hosted inference routing
            depends on provider settings; the full posture is on the security
            page.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
          <Link href="/security" className="btn-primary text-center">
            Read the security page
          </Link>
          <Link
            href="/install"
            className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-center text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
          >
            Install the CLI
          </Link>
        </div>
      </div>
    </div>
  );
}
