export const doctorTranscript = `[ok  ] config           loaded from defaults (model: deepseek/deepseek-v4-pro, gate failOn: error, minConfidence: 0.6)
[ok  ] git              inside a git work tree
[ok  ] api key          POSTIL_API_KEY, OPENROUTER_API_KEY, MODEL_API_KEY, LLM_API_KEY is set (value not shown)
[ok  ] model endpoint   http://127.0.0.1:9999/v1 answered for model deepseek/deepseek-v4-pro
[ok  ] forge tokens     presence only: GITHUB_TOKEN unset, GITLAB_TOKEN unset (only needed for remote review)

postil doctor: ready.`;

export const planTranscript = `postil plan: replaying 1 stored review(s) under candidate config (defaults)

  review-example.json: 2 -> 2 finding(s); gate: failing (unchanged)

Summary: 0 finding(s) would be suppressed; 0 gate outcome(s) would change.`;
