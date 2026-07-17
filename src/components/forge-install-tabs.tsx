"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Terminal } from "@/components/terminal";
import {
  PUBLIC_POSTIL_ACTION_SHA,
  PUBLIC_POSTIL_CLI_RELEASE,
  PUBLIC_POSTIL_CLI_SHA,
} from "@/lib/public-cli-example";

type ForgeId = "github" | "gitlab" | "bitbucket" | "azure";

const TABS: { id: ForgeId; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
  { id: "bitbucket", label: "Bitbucket" },
  { id: "azure", label: "Azure DevOps" },
];

const FORGE_IDS = new Set<ForgeId>(TABS.map((tab) => tab.id));

function isForgeId(value: string | null): value is ForgeId {
  return value !== null && FORGE_IDS.has(value as ForgeId);
}

function CliInstallStep({ forge }: { forge: Exclude<ForgeId, "github"> }) {
  const credentials = {
    gitlab: (
      <>
        Store a project or group access token as{" "}
        <code className="font-mono text-xs">GITLAB_TOKEN</code> and your
        inference key as{" "}
        <code className="font-mono text-xs">MODEL_API_KEY</code>.
      </>
    ),
    bitbucket: (
      <>
        Store an access token as{" "}
        <code className="font-mono text-xs">BITBUCKET_TOKEN</code> and your
        inference key as{" "}
        <code className="font-mono text-xs">MODEL_API_KEY</code>. App passwords
        also require{" "}
        <code className="font-mono text-xs">BITBUCKET_USER</code>.
      </>
    ),
    azure: (
      <>
        Store a Code (Read &amp; Write) PAT as{" "}
        <code className="font-mono text-xs">AZURE_DEVOPS_TOKEN</code> and your
        inference key as{" "}
        <code className="font-mono text-xs">MODEL_API_KEY</code>.
      </>
    ),
  };

  return (
    <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
      <div>
        <p className="font-mono text-sm text-charcoal/70">01</p>
        <h2 className="serif-display mt-1 text-2xl">Install the CLI</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Run Postil inside your forge&apos;s CI environment.
        </p>
      </div>
      <div className="min-w-0 space-y-4">
        <Terminal title="install Postil">
          <code>
            <span className="t-dim">$</span> curl -fsSL https://postil.dev/install.sh | sh{"\n"}
          </code>
        </Terminal>
        <p className="text-sm text-ink-soft">{credentials[forge]}</p>
        <p className="text-sm text-ink-soft">
          The install script verifies the published SHA-256 checksum. Full
          checksum and cosign verification details remain below these forge
          instructions.
        </p>
      </div>
    </section>
  );
}

function GitHubPanel({ githubAppUrl }: { githubAppUrl: string }) {
  return (
    <div className="space-y-12">
      <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
        <div>
          <p className="font-mono text-sm text-charcoal/70">01</p>
          <h2 className="serif-display mt-1 text-2xl">GitHub App with BYOK</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Automatic reviews after you connect your model provider.
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-ink-soft">
            Choose all repositories or a selected set during installation.
            Then open organization settings and configure the provider API,
            model, and key. New non-draft pull requests are reviewed after
            setup. Draft pull requests are skipped until they are marked ready.
            Existing open pull requests are not reviewed retroactively unless
            a review is requested again.
          </p>
          <p className="mt-3 text-sm text-ink-soft">
            You can disable individual repositories from the organization
            dashboard. The App also answers{" "}
            <code className="font-mono text-sm">@postil</code> mentions on PRs
            and issues. It reviews and answers only; it never opens PRs or
            pushes commits.
          </p>
          <p className="mt-3 text-sm text-ink-soft">
            The App uses the same review engine as the CLI, GitHub Action, and
            self-hosted stack.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <a href={githubAppUrl} className="btn-primary">
              Install the GitHub App
            </a>
            <Link href="/docs/forges/github" className="btn-secondary">
              GitHub walkthrough
            </Link>
            <Link href="/docs/self-hosted" className="text-sm text-rust underline">
              Self-host instead
            </Link>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            Permissions requested: contents (read), pull requests (write),
            checks (write), metadata (read). Never write access to your code.
            See the{" "}
            <Link href="/security" className="text-rust underline">
              security page
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
        <div>
          <p className="font-mono text-sm text-charcoal/70">02</p>
          <h2 className="serif-display mt-1 text-2xl">GitHub Action</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Optional CI reviews and merge blocking with your own model key.
          </p>
        </div>
        <div className="min-w-0 space-y-4">
          <Terminal title=".github/workflows/review.yml">
            <code>
              {`on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  postil:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write
    steps:
      - uses: actions/checkout@v4
      - uses: postil-dev/postil-action@${PUBLIC_POSTIL_ACTION_SHA}
        with:
          cli-ref: `}
              <span className="t-rust">{PUBLIC_POSTIL_CLI_SHA}</span>
              {`
          cli-release: ${PUBLIC_POSTIL_CLI_RELEASE}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          MODEL_API_KEY: \${{ secrets.MODEL_API_KEY }}
          POSTIL_API_KEY: \${{ secrets.MODEL_API_KEY }}`}
            </code>
          </Terminal>
          <p className="text-sm text-ink-soft">
            The action requires a full 40-character commit SHA for{" "}
            <code className="font-mono text-xs">cli-ref</code>. Require{" "}
            <code className="font-mono text-xs">postil/gate</code> in branch
            protection when review failures should block merges. The GitHub App
            starts reviewing after BYOK setup without this CI workflow.
          </p>
        </div>
      </section>
    </div>
  );
}

function GitLabPanel() {
  return (
    <div className="space-y-12">
      <CliInstallStep forge="gitlab" />
      <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
        <div>
          <p className="font-mono text-sm text-charcoal/70">02</p>
          <h2 className="serif-display mt-1 text-2xl">Add the CI job</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Review merge requests on GitLab.com or GitLab Self-Managed.
          </p>
        </div>
        <div className="min-w-0 space-y-4">
          <p className="text-ink-soft">
            The CLI posts inline discussion notes on the merge request and
            reports the gate verdict through the job&apos;s exit code.
          </p>
          <Terminal title=".gitlab-ci.yml">
            <code>{`postil:
  image: debian:bookworm-slim
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  before_script:
    - apt-get update && apt-get install -y curl ca-certificates
    - curl -fsSL https://postil.dev/install.sh | sh
    - export PATH="$HOME/.local/bin:$PATH"
  script:
    - export POSTIL_API_KEY="$MODEL_API_KEY"
    - postil review --forge gitlab
        --repo $CI_PROJECT_PATH
        --pr $CI_MERGE_REQUEST_IID`}</code>
          </Terminal>
          <p className="text-sm text-ink-soft">
            The full guide covers token roles, required pipelines, local runs,
            and custom API URLs for self-managed instances.{" "}
            <Link href="/docs/forges/gitlab" className="text-rust underline">
              Follow the GitLab walkthrough
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}

function BitbucketPanel() {
  return (
    <div className="space-y-12">
      <CliInstallStep forge="bitbucket" />
      <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
        <div>
          <p className="font-mono text-sm text-charcoal/70">02</p>
          <h2 className="serif-display mt-1 text-2xl">Add the pipeline step</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Review pull requests in Bitbucket Pipelines.
          </p>
        </div>
        <div className="min-w-0 space-y-4">
          <p className="text-ink-soft">
            The CLI posts inline comments and makes a gate-failing review fail
            the pipeline step.
          </p>
          <Terminal title="bitbucket-pipelines.yml">
            <code>{`pipelines:
  pull-requests:
    '**':
      - step:
          name: postil review
          image: debian:bookworm-slim
          script:
            - apt-get update && apt-get install -y curl ca-certificates
            - curl -fsSL https://postil.dev/install.sh | sh
            - export PATH="$HOME/.local/bin:$PATH"
            - export POSTIL_API_KEY="$MODEL_API_KEY"
            - postil review --forge bitbucket
                --repo $BITBUCKET_WORKSPACE/$BITBUCKET_REPO_SLUG
                --pr $BITBUCKET_PR_ID`}</code>
          </Terminal>
          <p className="text-sm text-ink-soft">
            The full guide covers access-token options, required branch
            restrictions, local runs, and Bitbucket Data Center.{" "}
            <Link href="/docs/forges/bitbucket" className="text-rust underline">
              Follow the Bitbucket walkthrough
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}

function AzurePanel() {
  return (
    <div className="space-y-12">
      <CliInstallStep forge="azure" />
      <section className="rule grid gap-8 pt-10 md:grid-cols-[1fr_2fr]">
        <div>
          <p className="font-mono text-sm text-charcoal/70">02</p>
          <h2 className="serif-display mt-1 text-2xl">Add the pipeline step</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Review pull requests in Azure Pipelines.
          </p>
        </div>
        <div className="min-w-0 space-y-4">
          <p className="text-ink-soft">
            The CLI posts PR thread comments and makes a gate-failing review
            fail the pipeline step.
          </p>
          <Terminal title="azure-pipelines.yml">
            <code>{`trigger: none
pr:
  branches:
    include: ['*']

pool:
  vmImage: ubuntu-latest

steps:
  - script: |
      curl -fsSL https://postil.dev/install.sh | sh
      export PATH="$HOME/.local/bin:$PATH"
      org="$(basename "\${SYSTEM_COLLECTIONURI%/}")"
      postil review --forge azure \\
        --repo "$org/$SYSTEM_TEAMPROJECT/$BUILD_REPOSITORY_NAME" \\
        --pr "$SYSTEM_PULLREQUEST_PULLREQUESTID"
    env:
      AZURE_DEVOPS_TOKEN: $(AZURE_DEVOPS_TOKEN)
      MODEL_API_KEY: $(MODEL_API_KEY)
      POSTIL_API_KEY: $(MODEL_API_KEY)`}</code>
          </Terminal>
          <p className="text-sm text-ink-soft">
            The full guide covers PAT permissions, required branch policies,
            local runs, and Azure DevOps Server.{" "}
            <Link href="/docs/forges/azure" className="text-rust underline">
              Follow the Azure DevOps walkthrough
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}

/**
 * Forge-aware install instructions. All panels stay in the rendered tree so
 * their content is available in the server response; the active panel is
 * selected from ?forge=<id> after hydration.
 */
export function ForgeInstallTabs({ githubAppUrl }: { githubAppUrl: string }) {
  const [active, setActive] = useState<ForgeId>("github");

  useEffect(() => {
    const forge = new URLSearchParams(window.location.search).get("forge");
    if (isForgeId(forge)) {
      setActive(forge);
    }
  }, []);

  function selectForge(forge: ForgeId) {
    setActive(forge);

    const url = new URL(window.location.href);
    url.searchParams.set("forge", forge);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  const panels: Record<ForgeId, React.ReactNode> = {
    github: <GitHubPanel githubAppUrl={githubAppUrl} />,
    gitlab: <GitLabPanel />,
    bitbucket: <BitbucketPanel />,
    azure: <AzurePanel />,
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label="Code forge"
        className="flex gap-1 overflow-x-auto border-b border-stone"
      >
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`forge-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`forge-panel-${tab.id}`}
              onClick={() => selectForge(tab.id)}
              className={`-mb-px shrink-0 rounded-t-card border border-b-0 px-4 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "border-stone bg-charcoal text-ivory"
                  : "border-transparent text-charcoal/70 hover:text-charcoal"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {TABS.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`forge-panel-${tab.id}`}
          aria-labelledby={`forge-tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          {panels[tab.id]}
        </div>
      ))}
    </div>
  );
}
