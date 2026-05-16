// src/action.ts
import { readFileSync } from "fs";

// src/diff.ts
function parseUnifiedDiff(diffText) {
  const lines = diffText.split("\n");
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      if (currentFile) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        files.push(currentFile);
      }
      currentFile = { oldPath: "", newPath: "", hunks: [] };
      continue;
    }
    if (line.startsWith("--- ")) {
      if (currentFile) {
        currentFile.oldPath = line.slice(4).split("	")[0].replace(/^a\//, "");
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (currentFile) {
        currentFile.newPath = line.slice(4).split("	")[0].replace(/^b\//, "");
      }
      continue;
    }
    if (line.startsWith("@@")) {
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk);
      }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldLines: match[2] ? parseInt(match[2], 10) : 1,
          newStart: parseInt(match[3], 10),
          newLines: match[4] ? parseInt(match[4], 10) : 1,
          lines: []
        };
      }
      continue;
    }
    if (currentHunk) {
      currentHunk.lines.push(line);
    }
  }
  if (currentFile) {
    if (currentHunk) {
      currentFile.hunks.push(currentHunk);
    }
    files.push(currentFile);
  }
  return files;
}

// src/prompt.ts
function buildReviewPrompt(diffFiles) {
  const diffText = diffFiles.map(
    (f) => `File: ${f.newPath}
` + f.hunks.map(
      (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@
` + h.lines.join("\n")
    ).join("\n")
  ).join("\n\n");
  return `You are an expert code reviewer. Review the following unified diff and produce a structured review.

Rules:
- Be concise and specific.
- Focus on bugs, security issues, performance problems, and maintainability.
- Praise good practices when you see them.
- Every comment must include the exact file path and line number in the NEW version of the file.
- Severity must be one of: critical, warning, suggestion, praise.

Respond ONLY with valid JSON in this exact shape (no markdown fences):

{
  "summary": "One-sentence overall assessment.",
  "comments": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "warning",
      "message": "Description of the issue.",
      "suggestion": "Optional concrete fix or improvement."
    }
  ]
}

Diff:
${diffText}
`;
}

// src/llm.ts
var OpenAIClient = class {
  apiKey;
  model;
  baseUrl;
  maxTokens;
  temperature;
  constructor(options) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-4o-mini";
    this.baseUrl = options.baseUrl ?? "https://api.openai.com";
    this.maxTokens = options.maxTokens ?? 4096;
    this.temperature = options.temperature ?? 0.2;
  }
  async complete(prompt) {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: this.maxTokens,
        temperature: this.temperature
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.choices[0]?.message?.content ?? "";
  }
};
var AnthropicClient = class {
  apiKey;
  model;
  baseUrl;
  maxTokens;
  temperature;
  constructor(options) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-3-5-haiku-20241022";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.maxTokens = options.maxTokens ?? 4096;
    this.temperature = options.temperature ?? 0.2;
  }
  async complete(prompt) {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.content.find((c) => c.type === "text")?.text ?? "";
  }
};
function createLLMClient(options) {
  if (options.provider === "openai") {
    return new OpenAIClient(options);
  }
  if (options.provider === "anthropic") {
    return new AnthropicClient(options);
  }
  throw new Error(`Unknown provider: ${options.provider}`);
}

// src/review.ts
function parseReviewResponse(raw) {
  const cleaned = raw.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed.comments)) {
    throw new Error("LLM response missing comments array");
  }
  return {
    summary: parsed.summary ?? "No summary provided.",
    comments: parsed.comments.map((c) => ({
      file: c.file ?? "unknown",
      line: typeof c.line === "number" ? c.line : 0,
      severity: ["critical", "warning", "suggestion", "praise"].includes(c.severity) ? c.severity : "suggestion",
      message: c.message ?? "",
      suggestion: c.suggestion
    }))
  };
}
async function generateReview(diffText, options) {
  const diffFiles = parseUnifiedDiff(diffText);
  const prompt = buildReviewPrompt(diffFiles);
  const client = createLLMClient(options.llm);
  const raw = await client.complete(prompt);
  return parseReviewResponse(raw);
}

// src/github.ts
async function fetchPullRequestDiff(ctx) {
  const url = `${ctx.apiUrl ?? "https://api.github.com"}/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.pullNumber}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github.v3.diff",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return res.text();
}
async function getPullRequestHeadSha(ctx) {
  const url = `${ctx.apiUrl ?? "https://api.github.com"}/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.pullNumber}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.head.sha;
}
async function createReviewComments(ctx, result) {
  const apiUrl = ctx.apiUrl ?? "https://api.github.com";
  const commitId = await getPullRequestHeadSha(ctx);
  const summaryBody = formatSummaryBody(result);
  const summaryRes = await fetch(
    `${apiUrl}/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.pullNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({ body: summaryBody })
    }
  );
  if (!summaryRes.ok) {
    const text = await summaryRes.text();
    throw new Error(`GitHub API error ${summaryRes.status}: ${text}`);
  }
  if (result.comments.length > 0) {
    const reviewRes = await fetch(
      `${apiUrl}/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.pullNumber}/reviews`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({
          commit_id: commitId,
          event: "COMMENT",
          comments: result.comments.filter((c) => c.line > 0).map((c) => ({
            path: c.file,
            line: c.line,
            body: formatCommentBody(c)
          }))
        })
      }
    );
    if (!reviewRes.ok) {
      const text = await reviewRes.text();
      throw new Error(`GitHub API error ${reviewRes.status}: ${text}`);
    }
  }
}
function formatSummaryBody(result) {
  let body = `## Postil Review

${result.summary}
`;
  if (result.comments.length === 0) {
    body += "\nNo inline comments.\n";
  } else {
    body += `
**${result.comments.length} inline comment(s) posted.**
`;
  }
  body += "\n_Posted by [Postil](https://github.com/your-org/postil) \xB7 AI code review_\n";
  return body;
}
function formatCommentBody(comment) {
  const emoji = comment.severity === "critical" ? "\u{1F6A8}" : comment.severity === "warning" ? "\u26A0\uFE0F" : comment.severity === "praise" ? "\u2705" : "\u{1F4A1}";
  let body = `${emoji} **${comment.severity.toUpperCase()}**

${comment.message}`;
  if (comment.suggestion) {
    body += `

**Suggestion:**
\`\`\`
${comment.suggestion}
\`\`\``;
  }
  return body;
}

// src/action.ts
function getInput(name) {
  const val = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
  return val ?? "";
}
function getRequiredInput(name) {
  const val = getInput(name);
  if (!val) {
    throw new Error(`Missing required input: ${name}`);
  }
  return val;
}
function parseInputs() {
  return {
    apiKey: getRequiredInput("api-key"),
    provider: getInput("provider") || "openai",
    model: getInput("model") || void 0,
    configPath: getInput("config-path") || void 0,
    githubToken: getInput("github-token") || process.env.GITHUB_TOKEN || ""
  };
}
function parseGitHubContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH not set");
  }
  const event = JSON.parse(
    readFileSync(eventPath, "utf-8")
  );
  if (!event.pull_request) {
    throw new Error("This action must run on a pull_request event");
  }
  const fullName = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
  if (!fullName) {
    throw new Error("Unable to determine repository");
  }
  const [owner, repo] = fullName.split("/");
  const inputs = parseInputs();
  const token = inputs.githubToken;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }
  return {
    token,
    owner,
    repo,
    pullNumber: event.pull_request.number,
    apiUrl: process.env.GITHUB_API_URL
  };
}
async function main() {
  const inputs = parseInputs();
  const gh = parseGitHubContext();
  const diff = await fetchPullRequestDiff(gh);
  const result = await generateReview(diff, {
    llm: { provider: inputs.provider, apiKey: inputs.apiKey, model: inputs.model },
    outputFormat: "json"
  });
  await createReviewComments(gh, result);
  console.log("Review posted successfully.");
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`Action failed: ${err.message}`);
    process.exit(1);
  });
}
export {
  main
};
//# sourceMappingURL=action.js.map