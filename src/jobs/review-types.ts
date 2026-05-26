import { z } from "zod";

export const reviewPayload = z.object({
  installationId: z.number().int(),
  repoFullName: z.string(),
  pullNumber: z.number().int(),
  headSha: z.string(),
  checkRunId: z.number().int().optional(),
  reviewId: z.string().uuid().optional(),
});

export type ReviewPayload = z.infer<typeof reviewPayload>;

export const reviewFinding = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  severity: z.enum(["info", "warn", "error"]),
  body: z.string(),
});

export type ReviewFinding = z.infer<typeof reviewFinding>;

export const tokenUsage = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export type TokenUsage = z.infer<typeof tokenUsage>;

export const reviewEnvelope = z.object({
  summary: z.string(),
  findings: z.array(reviewFinding),
  usage: tokenUsage,
  modelUsed: z.string().optional(),
});

export type ReviewEnvelope = z.infer<typeof reviewEnvelope>;
