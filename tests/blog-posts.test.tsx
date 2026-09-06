import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import BlogIndexPage from "@/app/blog/page";
import LeastUsefulNumberArticle from "@/app/blog/the-least-useful-number/page";
import EvidenceLinksArticle from "@/app/blog/evidence-has-to-link-back/page";
import GateSeparateFromReviewArticle from "@/app/blog/the-gate-is-separate-from-the-review/page";
import BenchmarksArticle from "@/app/blog/ai-code-review-benchmarks/page";
import evidence from "../public/bench/screening-0.8.26-case-evidence.json";
import cleanBank from "../public/bench/screening-0.9.7-clean-bank-v2.json";
import { BENCH } from "@/components/bench-table";
import {
  BLOG_POSTS,
  blogPostJsonLd,
  blogPostMetadata,
  formatBlogPublicationDate,
  orderedBlogPosts,
  type BlogPost,
} from "@/lib/blog-posts";

describe("blog publication metadata", () => {
  test("orders newest articles first with a deterministic slug tie-break", () => {
    expect(orderedBlogPosts().map((post) => post.slug)).toEqual([
      "the-least-useful-number",
      "evidence-has-to-link-back",
      "the-gate-is-separate-from-the-review",
      "ai-code-review-benchmarks",
      "ai-code-review-pricing-2026",
      "best-ai-code-review-tools-2026",
      "self-hosted-ai-code-review",
      "why-copilot-cant-block-your-merge",
      "where-does-your-code-go",
      "silence-rate",
    ]);

    const fixtures = [
      fixture("same-day-b", "2026-03-04"),
      fixture("older", "2025-12-31"),
      fixture("same-day-a", "2026-03-04"),
      fixture("newer", "2027-01-01"),
    ];
    expect(orderedBlogPosts(fixtures).map((post) => post.slug)).toEqual([
      "newer",
      "same-day-a",
      "same-day-b",
      "older",
    ]);
  });

  test("formats exact publication days in UTC with a stable locale", () => {
    expect(formatBlogPublicationDate("2026-07-11")).toBe("July 11, 2026");
    expect(formatBlogPublicationDate("2026-01-01")).toBe("January 1, 2026");
    expect(() => formatBlogPublicationDate("2026-02-30")).toThrow(
      "invalid blog publication date",
    );
  });

  test("derives canonical, Open Graph, and structured data from each record", () => {
    for (const record of BLOG_POSTS) {
      const post: BlogPost = record;
      expect(blogPostMetadata(post)).toMatchObject({
        title: post.title,
        description: post.description,
        alternates: { canonical: `/blog/${post.slug}` },
        openGraph: {
          type: "article",
          publishedTime: `${post.publishedOn}T00:00:00.000Z`,
          title: post.title,
          description: post.socialDescription,
          url: `https://postil.dev/blog/${post.slug}`,
        },
      });
      expect(blogPostJsonLd(post)).toMatchObject({
        headline: post.title,
        description: post.structuredDescription ?? post.description,
        url: `https://postil.dev/blog/${post.slug}`,
        datePublished: post.publishedOn,
      });
    }
  });

  test("preserves distinct page, social, and structured descriptions", () => {
    const post: BlogPost | undefined = BLOG_POSTS.find(
      (candidate) => candidate.slug === "ai-code-review-pricing-2026",
    );
    if (!post) throw new Error("pricing article is missing from the blog registry");

    const metadata = blogPostMetadata(post);
    expect(metadata.description).toBe(post.description);
    expect(metadata.openGraph?.description).toBe(post.socialDescription);
    expect(blogPostJsonLd(post).description).toBe(post.structuredDescription);
  });

  test("renders semantic exact dates in registry order", () => {
    const markup = renderToStaticMarkup(<BlogIndexPage />);
    const ordered = orderedBlogPosts();
    let previous = -1;
    for (const post of ordered) {
      const position = markup.indexOf(`href="/blog/${post.slug}"`);
      expect(position).toBeGreaterThan(previous);
      expect(markup).toContain(`dateTime="${post.publishedOn}"`);
      expect(markup).toContain(formatBlogPublicationDate(post.publishedOn));
      previous = position;
    }
  });

  test("renders article headings and exact dates from the same record", () => {
    const post = BLOG_POSTS[0];
    const markup = renderToStaticMarkup(<BlogArticleHeader post={post} />);
    expect(markup).toContain(
      `<h1 class="serif-display mt-4 text-4xl md:text-5xl">${post.title}</h1>`,
    );
    expect(markup).toContain(`dateTime="${post.publishedOn}"`);
    expect(markup).toContain(formatBlogPublicationDate(post.publishedOn));
  });

  test("keeps every article page bound to the central registry", async () => {
    const blogDirectory = join(import.meta.dir, "..", "src", "app", "blog");
    const slugs = (await readdir(blogDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(slugs).toEqual(BLOG_POSTS.map((post) => post.slug).sort());

    for (const slug of slugs) {
      const source = await readFile(join(blogDirectory, slug, "page.tsx"), "utf8");
      expect(source).toContain(`getBlogPost("${slug}")`);
      expect(source).toContain("blogPostMetadata(post)");
      expect(source).toContain("blogPostJsonLd(post)");
      expect(source).toContain("<BlogArticleHeader post={post} />");
      expect(source).not.toMatch(
        /publishedTime:|datePublished:|(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4} · Postil team/,
      );
    }
  });
});

describe("published blog evidence", () => {
  test("keeps the expanded clean experiment separate from historical denominators", () => {
    expect(BENCH.defectCases).toBe(57);
    expect(BENCH.cleanCases).toBe(13);
    expect(cleanBank.fixtures).toHaveLength(25);
    expect(cleanBank.fixtures.filter(fixture => fixture.bank === "supplemental")).toHaveLength(12);
    expect(cleanBank.fixtureCorpusSha256).not.toBe(evidence.fixtureCorpusSha256);
    for (const model of cleanBank.models) {
      expect(model.rows.map(row => row.id).sort()).toEqual(cleanBank.fixtures.map(fixture => fixture.id).sort());
      expect(model.total).toMatchObject({ attempted: 25, finalReviewsSilent: 25, casesWithFinalFindings: 0, unavailable: 0 });
      expect(model.rows.every(row => row.scored && row.finalReviewSilent && row.finalFindings.length === 0)).toBe(true);
    }
    const html = renderToStaticMarkup(<LeastUsefulNumberArticle />);
    expect(html).toContain("13 / 13");
    expect(html).toContain("25 / 25");
    expect(html).toContain("azure/eu");
    expect(html).toContain("z-ai/fp8");
  });
  test("preserves suppressed candidates separately from final silence and pins reproduction", () => {
    const glm = cleanBank.models.find(model => model.model === "z-ai/glm-5.2")!;
    const dependency = glm.rows.find(row => row.id === "dependency-major-bump")!;
    expect(dependency.finalFindings).toEqual([]);
    expect(dependency.suppressedFindings).toMatchObject([
      { reason: "belowConfidence", finding: { confidence: 0.4, severity: "warn" } },
    ]);
    for (const model of cleanBank.models) {
      expect(model.rows.reduce((total, row) => total + row.suppressedFindings.length, 0)).toBe(model.total.suppressedFindings);
      expect(model.rows.reduce((total, row) => total + row.finalFindings.length, 0)).toBe(model.total.finalFindings);
      expect(model.reproduction.profile.scorerChain).toEqual([]);
      expect(model.reproduction.profileUrl).toContain(cleanBank.reproduction.sourceCommit);
      expect(model.reproduction.invocation).toContain('"--concurrency", "3", "--retries", "0"');
    }
    expect(cleanBank.reproduction.selectedCaseIds).toEqual(cleanBank.fixtures.map(fixture => fixture.id));
    expect(cleanBank.reproduction.sourceCommit).toBe("a7e7c67235519fff79c6e82c44550ac29255dcdc");
    const development = cleanBank.developmentEvidence.initialFixturePair;
    expect(development.luna.finalFindings).toBe(1);
    expect(development.luna.rows.find(row => row.id === "clean-optional-field-presence")!.finalFindings).toHaveLength(1);
    expect(development.fixture.diff).toContain("Object.hasOwn");
  });

  test("accounts for every attempted review without treating unavailable output as a pass", () => {
    for (const run of evidence.runs) {
      const model = BENCH.models.find(model => model.id === run.model)!;
      expect(run.results).toHaveLength(model.casesRun);
      expect(Object.values(run.counts).reduce((sum, count) => sum + count, 0)).toBe(model.casesRun);
      expect(run.results.filter(result => result.verdict === "unavailable")).toHaveLength(model.unscoredCases);
      expect((run.counts.correctPass + run.counts.correctBlock) / (run.results.length - run.counts.unavailable)).toBeCloseTo(model.gateVerdictCorrectness!, 12);
      expect(run.results.filter(result => result.detected).length / BENCH.defectCases).toBeCloseTo(model.detectionRate!, 12);
      for (const result of run.results.filter(result => !result.scored)) {
        expect(result.actualBlock).toBeNull();
        expect(result.silent).toBeNull();
        expect(result.verdict).toBe("unavailable");
      }
    }
  });

  test("retains the duplicate finding and its shared target location", () => {
    const glm = evidence.runs.find(run => run.model === "z-ai/glm-5.2")!;
    const sample = glm.samples.find(sample => sample.id === "misleading-comment-fallback-throws")!;
    expect(sample.findings).toHaveLength(2);
    expect(sample.findings.map(finding => [finding.path, finding.line])).toEqual([
      ["src/config/load.ts", 26], ["src/config/load.ts", 26],
    ]);
    expect(glm.results.reduce((total, result) => total + result.unmatchedFindings, 0)).toBe(3);
  });

  test("renders all revised articles and resolves their public evidence files", async () => {
    for (const Page of [LeastUsefulNumberArticle, EvidenceLinksArticle, GateSeparateFromReviewArticle, BenchmarksArticle]) {
      const html = renderToStaticMarkup(<Page />);
      expect(html).toContain("<h1");
      expect(html).not.toMatch(/These need inspection|someone has to check them|findings outside the planted bug locations/);
      for (const [, asset] of html.matchAll(/href="(\/(?:bench|evidence)\/[^"#]+\.json)"/g)) {
        const content = await readFile(join(import.meta.dir, "..", "public", asset!), "utf8");
        expect(() => JSON.parse(content)).not.toThrow();
      }
    }
  });

  test("compares the same models and retains failed-repeat evidence", () => {
    const html = renderToStaticMarkup(<LeastUsefulNumberArticle />);
    const cleanFigure = html.slice(html.indexOf("Clean cases with a silent final Postil review"), html.indexOf("</figure>"));
    expect(cleanFigure).toContain("GPT-5.6 Luna");
    expect(cleanFigure).toContain("GLM-5.2");
    expect(html).toContain("16 of its 70 attempts are unavailable");
    expect(html).toContain("21.1 percentage points");
  });
});

function fixture(slug: string, publishedOn: string): BlogPost {
  return {
    slug,
    publishedOn,
    title: slug,
    description: slug,
    socialDescription: slug,
    excerpt: slug,
  };
}
