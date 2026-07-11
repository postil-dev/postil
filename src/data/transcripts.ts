export const doctorTranscript = `[ok  ] config           loaded from defaults (model: local-doctor-probe, gate failOn: error, minConfidence: 0.6)
[ok  ] git              inside a git work tree
[ok  ] api key          POSTIL_API_KEY, OPENROUTER_API_KEY, MODEL_API_KEY, LLM_API_KEY is set (value not shown)
[ok  ] model endpoint   http://127.0.0.1:3117/v1 answered for model local-doctor-probe
[ok  ] forge tokens     presence only: GITHUB_TOKEN unset, GITLAB_TOKEN unset (only needed for remote review)

postil doctor: ready.`;

export const planTranscript = `postil plan: replaying 1 stored review(s) under candidate config (.cache/docs-plan/.postil.candidate.yaml)

  prettier_prettier__19348.json: 3 -> 1 finding(s); gate: passing (unchanged)
      would suppress: src/cli/utilities.js:49 [warn] Hash algorithm change may break caching or other features relying on stable hash values
      would suppress: package.json:85 [warn] New dependency imurmurhash-esm at version 0.0.2 may be unstable

Summary: 2 finding(s) would be suppressed; 0 gate outcome(s) would change.`;
