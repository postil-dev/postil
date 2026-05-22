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

export type ReviewFinding = {
  path: string;
  line: number;
  severity: "info" | "warn" | "error";
  body: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ReviewEnvelope = {
  summary: string;
  findings: ReviewFinding[];
  usage: TokenUsage;
  modelUsed?: string;
};
