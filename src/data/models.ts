// Curated model list for /docs/models. Facts and public price snapshots are
// maintained in this repo so public docs do not depend on a third-party request
// at render time.
//
// These prices are also the rate card: `calculateUsageCostMicrosForModel` reads
// them to fill `usage_events.cost_micros`, so a model absent from this list
// records no cost at all, and a stale price here records the stale number. An
// entry stays after a model leaves the docs table if usage was ever attributed
// to its id.

export const MODEL_CATALOG_CAPTURE_DATE = "2026-08-19";

export type ParamClass = "unknown" | "<40B" | "40B-200B" | ">200B";

export interface ModelPrice {
  input: number;
  output: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  vision: boolean;
  openWeights: boolean;
  paramClass: ParamClass;
  /** <40B open-weights models are the ones worth calling out as locally runnable. */
  locallyRunnable: boolean;
  /** True once bench-results.json has a scored entry for this id. */
  tested: boolean;
  /** Public OpenRouter price per token for docs display. */
  pricePerToken: ModelPrice;
}

export const MODELS: CatalogModel[] = [
  {
    id: "z-ai/glm-5.2",
    name: "GLM 5.2",
    contextLength: 1_048_576,
    vision: false,
    openWeights: true,
    paramClass: ">200B",
    locallyRunnable: false,
    tested: true,
    pricePerToken: { input: 0.000000966, output: 0.000003036 },
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    contextLength: 262_144,
    vision: true,
    openWeights: true,
    paramClass: ">200B",
    locallyRunnable: false,
    tested: true,
    pricePerToken: { input: 0.00000071, output: 0.0000035 },
  },
  {
    id: "deepseek/deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro 0813",
    contextLength: 1_048_576,
    vision: false,
    openWeights: true,
    paramClass: ">200B",
    locallyRunnable: false,
    tested: true,
    pricePerToken: { input: 0.00000066, output: 0.00000198 },
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    contextLength: 262_144,
    vision: true,
    openWeights: true,
    paramClass: ">200B",
    locallyRunnable: false,
    tested: true,
    pricePerToken: { input: 0.00000095, output: 0.000004 },
  },
  {
    id: "deepseek/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash 0731",
    contextLength: 1_310_720,
    vision: false,
    openWeights: true,
    paramClass: "40B-200B",
    locallyRunnable: false,
    tested: true,
    pricePerToken: { input: 0.00000014, output: 0.00000028 },
  },
  {
    id: "qwen/qwen3.8-27b",
    name: "Qwen3.8 27B",
    contextLength: 262_144,
    vision: true,
    openWeights: true,
    paramClass: "<40B",
    locallyRunnable: true,
    tested: true,
    pricePerToken: { input: 0.00000045, output: 0.0000032 },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextLength: 1_048_576,
    vision: false,
    openWeights: true,
    paramClass: ">200B",
    locallyRunnable: false,
    tested: false,
    pricePerToken: { input: 0.00000144, output: 0.00000288 },
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextLength: 1_048_576,
    vision: false,
    openWeights: true,
    paramClass: "40B-200B",
    locallyRunnable: false,
    tested: false,
    pricePerToken: { input: 0.000000083, output: 0.000000165 },
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    contextLength: 1_050_000,
    vision: true,
    openWeights: false,
    paramClass: "unknown",
    locallyRunnable: false,
    tested: true,
    pricePerToken: { input: 0.0000002, output: 0.0000012 },
  },
  {
    id: "google/gemma-4-31b-it",
    name: "Gemma 4 31B",
    contextLength: 262_144,
    vision: true,
    openWeights: true,
    paramClass: "<40B",
    locallyRunnable: true,
    tested: true,
    pricePerToken: { input: 0.00000009, output: 0.00000034 },
  },
  {
    id: "nvidia/nemotron-3.5-lightning",
    name: "Nemotron 3.5 Lightning",
    contextLength: 1_000_000,
    vision: false,
    openWeights: true,
    paramClass: "40B-200B",
    locallyRunnable: false,
    tested: true,
    pricePerToken: { input: 0.00000008, output: 0.0000002 },
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    contextLength: 200_000,
    vision: true,
    openWeights: false,
    paramClass: "unknown",
    locallyRunnable: false,
    tested: false,
    pricePerToken: { input: 0.000001, output: 0.000005 },
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    contextLength: 400_000,
    vision: true,
    openWeights: false,
    paramClass: "unknown",
    locallyRunnable: false,
    tested: false,
    pricePerToken: { input: 0.00000025, output: 0.000002 },
  },
  {
    id: "qwen/qwen3-32b",
    name: "Qwen3 32B",
    contextLength: 131_072,
    vision: false,
    openWeights: true,
    paramClass: "<40B",
    locallyRunnable: true,
    tested: true,
    pricePerToken: { input: 0.00000008, output: 0.00000028 },
  },
  {
    id: "mistralai/mistral-small-3.2-24b-instruct",
    name: "Mistral Small 3.2 24B",
    contextLength: 256_000,
    vision: true,
    openWeights: true,
    paramClass: "<40B",
    locallyRunnable: true,
    tested: true,
    pricePerToken: { input: 0.000000093_75, output: 0.00000025 },
  },
  {
    id: "google/gemma-3-27b-it",
    name: "Gemma 3 27B",
    contextLength: 262_144,
    vision: true,
    openWeights: true,
    paramClass: "<40B",
    locallyRunnable: true,
    tested: true,
    pricePerToken: { input: 0.00000008, output: 0.00000045 },
  },
];
