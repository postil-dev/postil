import { lstat, readFile } from "node:fs/promises";

import { calculateUsageCostMicrosForModel } from "@/lib/billing-credits";

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_MODELS = 32;

export interface RespondUsageReceipt {
  promptTokens: number;
  completionTokens: number;
  modelUsed: string;
  actualMicros: number | null;
}

export async function readRespondUsageReceipt(path: string): Promise<RespondUsageReceipt> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("respond usage receipt is not a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("respond usage receipt permissions are not private");
  }
  if (metadata.size <= 0 || metadata.size > MAX_RECEIPT_BYTES) {
    throw new Error("respond usage receipt size is invalid");
  }
  return parseRespondUsageReceipt(await readFile(path, "utf8"));
}

export function parseRespondUsageReceipt(source: string): RespondUsageReceipt {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("respond usage receipt is not valid JSON");
  }
  const receipt = record(value, "respond usage receipt");
  exactKeys(receipt, ["version", "operation", "promptTokens", "completionTokens", "models"]);
  if (receipt.version !== 1 || receipt.operation !== "respond") {
    throw new Error("respond usage receipt version or operation is invalid");
  }
  const promptTokens = tokens(receipt.promptTokens, "promptTokens");
  const completionTokens = tokens(receipt.completionTokens, "completionTokens");
  if (!Array.isArray(receipt.models) || receipt.models.length === 0 || receipt.models.length > MAX_MODELS) {
    throw new Error("respond usage receipt models are invalid");
  }

  let modelPromptTokens = 0;
  let modelCompletionTokens = 0;
  let actualMicros = 0;
  let priced = true;
  const modelNames: string[] = [];
  for (const [index, item] of receipt.models.entries()) {
    const model = record(item, `respond usage receipt model ${index}`);
    exactKeys(model, ["model", "promptTokens", "completionTokens"]);
    if (
      typeof model.model !== "string" ||
      model.model.length === 0 ||
      model.model.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(model.model)
    ) {
      throw new Error("respond usage receipt model name is invalid");
    }
    const modelPrompt = tokens(model.promptTokens, `models[${index}].promptTokens`);
    const modelCompletion = tokens(
      model.completionTokens,
      `models[${index}].completionTokens`,
    );
    modelPromptTokens = safeAdd(modelPromptTokens, modelPrompt);
    modelCompletionTokens = safeAdd(modelCompletionTokens, modelCompletion);
    modelNames.push(model.model);
    const cost = calculateUsageCostMicrosForModel(model.model, modelPrompt, modelCompletion);
    if (cost === null) {
      priced = false;
    } else {
      actualMicros = safeAdd(actualMicros, cost);
    }
  }
  if (modelPromptTokens !== promptTokens || modelCompletionTokens !== completionTokens) {
    throw new Error("respond usage receipt aggregate tokens do not match model usage");
  }
  return {
    promptTokens,
    completionTokens,
    modelUsed: modelNames.join(", "),
    actualMicros: priced ? actualMicros : null,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("respond usage receipt contains unexpected fields");
  }
}

function tokens(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`respond usage receipt ${label} is invalid`);
  }
  return value as number;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new Error("respond usage receipt totals exceed safe integer range");
  }
  return total;
}
