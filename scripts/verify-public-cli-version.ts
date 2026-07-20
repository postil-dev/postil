#!/usr/bin/env bun

import release from "../src/data/public-cli-release.json";

export interface PublicCliPins {
  actionCommit: string;
  cliCommit: string;
  cliRelease: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const LINUX_X86_64_ARCHIVE = "postil-x86_64-unknown-linux-gnu.tar.gz";

function uniqueReference(
  source: string,
  pattern: RegExp,
  label: string,
): string {
  const references = [...source.matchAll(pattern)].map((match) => match[1]);
  if (references.length !== 1 || references[0] === undefined) {
    throw new Error(
      `${label} must contain exactly one complete Postil pin set`,
    );
  }
  return references[0];
}

export function parsePublicCliPins(
  source: string,
  label: string,
): PublicCliPins {
  const actionCommit = uniqueReference(
    source,
    /postil-dev\/postil-action@([^\s#]+)/g,
    label,
  );
  const cliCommit = uniqueReference(source, /\bcli-ref:\s*([^\s#]+)/g, label);
  const cliRelease = uniqueReference(
    source,
    /\bcli-release:\s*([^\s#]+)/g,
    label,
  );

  if (!SHA_PATTERN.test(actionCommit) || !SHA_PATTERN.test(cliCommit)) {
    throw new Error(`${label} contains a mutable or invalid commit pin`);
  }
  if (!RELEASE_PATTERN.test(cliRelease)) {
    throw new Error(`${label} contains an invalid release tag`);
  }
  return { actionCommit, cliCommit, cliRelease };
}

export function assertPublicCliPins(
  actual: PublicCliPins,
  label: string,
  options: { requireCanonicalAction?: boolean } = {},
): void {
  const keys = options.requireCanonicalAction === false
    ? (["cliCommit", "cliRelease"] as const)
    : (["actionCommit", "cliCommit", "cliRelease"] as const);
  for (const key of keys) {
    if (actual[key] !== release[key]) {
      throw new Error(
        `${label} ${key} is ${actual[key]}, expected ${release[key]} from public-cli-release.json`,
      );
    }
  }
}

async function fetchText(
  url: string,
  label: string,
  redirect: RequestRedirect = "error",
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "postil-version-authority",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN !== undefined) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, { headers, redirect });
    if (response.ok) {
      return await response.text();
    }
    if (attempt === 3 || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    await Bun.sleep(250 * 2 ** (attempt - 1));
  }
  throw new Error(`${label} could not be fetched`);
}

async function resolveCommit(
  repository: string,
  revision: string,
): Promise<string> {
  const encoded = encodeURIComponent(revision);
  const body = await fetchText(
    `https://api.github.com/repos/${repository}/commits/${encoded}`,
    `${repository}@${revision}`,
  );
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sha" in parsed) ||
    typeof parsed.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(parsed.sha)
  ) {
    throw new Error(
      `${repository}@${revision} returned an invalid commit identity`,
    );
  }
  return parsed.sha;
}

export function parseReleaseChecksum(source: string, label: string): string {
  const escapedArchive = LINUX_X86_64_ARCHIVE.replaceAll(".", "\\.");
  const match = source
    .trim()
    .match(new RegExp(`^([0-9a-f]{64})  ${escapedArchive}$`));
  if (!match?.[1] || !SHA256_PATTERN.test(match[1])) {
    throw new Error(`${label} returned an invalid release checksum`);
  }
  return match[1];
}

async function main(): Promise<void> {
  const consumers = [
    {
      label: "postil-action README",
      url: "https://raw.githubusercontent.com/postil-dev/postil-action/main/README.md",
    },
    {
      label: "postil-action-sandbox workflow",
      url: "https://raw.githubusercontent.com/postil-dev/postil-action-sandbox/main/.github/workflows/postil-review.yml",
    },
  ];

  const consumerPins: Array<{
    label: string;
    url: string;
    pins: PublicCliPins;
  }> = [];
  for (const [index, consumer] of consumers.entries()) {
    const source = await fetchText(consumer.url, consumer.label);
    const pins = parsePublicCliPins(source, consumer.label);
    assertPublicCliPins(
      pins,
      consumer.label,
      { requireCanonicalAction: index === 0 },
    );
    consumerPins.push({ ...consumer, pins });
  }

  const [
    releaseCommit,
    hostedCommit,
    publishedChecksum,
    ...consumerActionCommits
  ] =
    await Promise.all([
      resolveCommit("postil-dev/postil-cli", release.cliRelease),
      resolveCommit("postil-dev/postil-cli", release.hostedCliRelease),
      fetchText(
        `https://github.com/postil-dev/postil-cli/releases/download/${release.hostedCliRelease}/${LINUX_X86_64_ARCHIVE}.sha256`,
        `${release.hostedCliRelease} Linux x86_64 checksum`,
        "follow",
      ).then((source) =>
        parseReleaseChecksum(
          source,
          `${release.hostedCliRelease} Linux x86_64 checksum`,
        ),
      ),
      ...consumerPins.map(({ pins }) =>
        resolveCommit("postil-dev/postil-action", pins.actionCommit),
      ),
    ]);
  if (releaseCommit !== release.cliCommit) {
    throw new Error(
      `${release.cliRelease} resolves to ${releaseCommit}, expected ${release.cliCommit}`,
    );
  }
  for (const [index, resolved] of consumerActionCommits.entries()) {
    const consumer = consumerPins[index];
    if (!consumer || resolved !== consumer.pins.actionCommit) {
      throw new Error(
        `${consumer?.label ?? "consumer"} Action commit could not be resolved`,
      );
    }
  }
  if (hostedCommit !== release.hostedCliCommit) {
    throw new Error(
      `${release.hostedCliRelease} resolves to ${hostedCommit}, expected ${release.hostedCliCommit}`,
    );
  }
  if (publishedChecksum !== release.hostedCliLinuxX86_64Sha256) {
    throw new Error(
      `${release.hostedCliRelease} Linux x86_64 checksum is ${publishedChecksum}, expected ${release.hostedCliLinuxX86_64Sha256}`,
    );
  }

  console.log(
    `public CLI pins verified at ${release.cliRelease}; hosted CLI verified at ${release.hostedCliRelease}`,
  );
}

if (import.meta.main) {
  await main();
}
