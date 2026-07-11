export const doctorTranscript = `[ok  ] config           loaded from defaults (model: local-doctor-probe, gate failOn: error, minConfidence: 0.6)
[ok  ] git              inside a git work tree
[ok  ] api key          POSTIL_API_KEY, OPENROUTER_API_KEY, MODEL_API_KEY, LLM_API_KEY is set (value not shown)
[ok  ] model endpoint   http://127.0.0.1:3117/v1 answered for model local-doctor-probe
[ok  ] forge tokens     presence only: GITHUB_TOKEN unset, GITLAB_TOKEN unset (only needed for remote review)

postil doctor: ready.`;

export const planTranscript = `postil plan: replaying 1 stored review(s) under candidate config (.cache/docs-plan/.postil.candidate.yaml)

  swapped-shas-public-evidence.json: 2 -> 0 finding(s); gate: FAILING -> passing
      would suppress: src/app/docs/quickstart/page.tsx:71 [error] Fix cli-ref to use CLI repository SHA
      would suppress: src/app/docs/page.tsx:92 [error] Fix cli-ref to use CLI repository SHA

Summary: 2 finding(s) would be suppressed; 1 gate outcome(s) would change.`;
