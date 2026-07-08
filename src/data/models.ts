// Curated model list for /docs/models. Facts and public price snapshots are
// maintained in this repo so public docs do not depend on a third-party request
// at render time.

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
  recommended: boolean;
  /** True once bench-results.json has a scored entry for this id. */
  tested: boolean;
  /** Public OpenRouter price per token for docs display. */
  pricePerToken: ModelPrice;
}

export const MODELS: CatalogModel[] = [
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextLength: 1_048_576,
    vision: false,
    openWeights: true,
    paramClass: ">200B",
    locallyRunnable: false,
    recommended: true,
    tested: true,
    pricePerToken: { input: 0.000000435, output: 0.00000087 },
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    contextLength: 262_144,
    vision: true,
    openWeights: true,
    paramClass: ">200B",
    locallyRunnable: false,
    recommended: false,
    tested: true,
    pricePerToken: { input: 0.00000065, output: 0.00000341 },
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextLength: 1_048_576,
    vision: false,
    openWeights: true,
    paramClass: "40B-200B",
    locallyRunnable: false,
    recommended: false,
    tested: true,
    pricePerToken: { input: 0.00000009, output: 0.00000018 },
  },
  {
    id: "qwen/qwen3-32b",
    name: "Qwen3 32B",
    contextLength: 131_072,
    vision: false,
    openWeights: true,
    paramClass: "<40B",
    locallyRunnable: true,
    recommended: false,
    tested: true,
    pricePerToken: { input: 0.00000008, output: 0.00000028 },
  },
  {
    id: "mistralai/mistral-small-3.2-24b-instruct",
    name: "Mistral Small 3.2 24B",
    contextLength: 128_000,
    vision: true,
    openWeights: true,
    paramClass: "<40B",
    locallyRunnable: true,
    recommended: false,
    tested: true,
    pricePerToken: { input: 0.000000075, output: 0.0000002 },
  },
  {
    id: "google/gemma-3-27b-it",
    name: "Gemma 3 27B",
    contextLength: 131_072,
    vision: true,
    openWeights: true,
    paramClass: "<40B",
    locallyRunnable: true,
    recommended: false,
    tested: true,
    pricePerToken: { input: 0.00000008, output: 0.00000016 },
  },
];
