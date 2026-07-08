// Curated model list for /docs/models. Facts only — no prices. Prices are
// fetched live from the OpenRouter catalog client-side (see model-catalog.tsx)
// so this file never goes stale against what OpenRouter actually bills.
//
// contextLength and vision are asserted here from a point-in-time check of
// https://openrouter.ai/api/v1/models and cross-checked live at render time;
// if the catalog disagrees, the live fetch is what renders.

export type ParamClass = "unknown" | "<40B" | "40B-200B" | ">200B";

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
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    contextLength: 262_144,
    vision: true,
    openWeights: true,
    paramClass: ">200B",
    locallyRunnable: false,
    recommended: true,
    tested: true,
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
  },
];
