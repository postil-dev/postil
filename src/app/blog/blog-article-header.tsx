import { formatBlogPublicationDate, type BlogPost } from "@/lib/blog-posts";

export function BlogArticleHeader({ post }: { post: BlogPost }) {
  return (
    <>
      <p className="eyebrow">Blog</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">{post.title}</h1>
      <p className="mt-4 font-mono text-sm text-charcoal/70">
        <time dateTime={post.publishedOn}>
          {formatBlogPublicationDate(post.publishedOn)}
        </time>{" "}
        · Postil team
      </p>
    </>
  );
}
