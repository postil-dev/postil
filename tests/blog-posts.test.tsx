import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import BlogIndexPage from "@/app/blog/page";
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
