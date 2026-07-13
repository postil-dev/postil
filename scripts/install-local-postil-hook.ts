import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const sourceHook = join(projectRoot, ".githooks", "pre-push");
const installedMarker = "# postil-local-hook:v1";

interface InstallOptions {
  force?: boolean;
  allowDelegatedHooksPath?: boolean;
  postilExecutable?: string;
  credentialWrapper?: string;
  ghExecutable?: string;
  secretsExecutable?: string;
}

export async function installLocalPostilHook(
  repositoryPath: string,
  options: InstallOptions = {},
): Promise<string> {
  const repositoryRoot = await git(repositoryPath, ["rev-parse", "--show-toplevel"]);
  const absoluteCommonDirectory = await git(repositoryRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const targetHook = join(absoluteCommonDirectory, "hooks", "pre-push");
  const effectiveHooksDirectory = await git(repositoryRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);
  if (resolve(effectiveHooksDirectory) !== dirname(targetHook)) {
    if (!options.allowDelegatedHooksPath) {
      throw new Error(
        `Git uses core.hooksPath=${effectiveHooksDirectory}; refusing to install an inactive hook. ` +
          "Use --allow-delegated-hooks-path only after verifying that its pre-push hook delegates " +
          "to the common Git directory.",
      );
    }
    const effectiveHook = join(effectiveHooksDirectory, "pre-push");
    const effectiveMode = await stat(effectiveHook).catch(() => undefined);
    if (!effectiveMode?.isFile() || (effectiveMode.mode & 0o111) === 0) {
      throw new Error(`delegating pre-push hook is not executable: ${effectiveHook}`);
    }
  }

  const postilExecutable = await resolveExecutable(
    options.postilExecutable ?? process.env.POSTIL_LOCAL_POSTIL_BIN ?? Bun.which("postil"),
    "postil",
  );
  const version = await run(postilExecutable, ["--version"]);
  const versionMatch = /^postil (\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/m.exec(version.stdout.trim());
  const supported =
    version.exitCode === 0 &&
    versionMatch !== null &&
    (Number(versionMatch[1]) > 0 || Number(versionMatch[2]) >= 6);
  if (!supported) {
    throw new Error(
      `local pre-push review requires Postil v0.6.0 or newer; ${postilExecutable} reported ${JSON.stringify(version.stdout.trim())}`,
    );
  }

  const [gitExecutable, jqExecutable, mktempExecutable] = await Promise.all([
    resolveExecutable(Bun.which("git"), "git"),
    resolveExecutable(Bun.which("jq"), "jq"),
    resolveExecutable(Bun.which("mktemp"), "mktemp"),
  ]);
  const ghCandidate = options.ghExecutable ?? Bun.which("gh");
  const ghExecutable = ghCandidate
    ? await resolveExecutable(ghCandidate, "gh", { preserveInvocationPath: true })
    : "";
  const secretsCandidate = options.secretsExecutable ?? Bun.which("secrets");
  const secretsExecutable = secretsCandidate
    ? await resolveExecutable(secretsCandidate, "secrets", { preserveInvocationPath: true })
    : "";
  const bunExecutable = secretsExecutable
    ? await resolveExecutable(Bun.which("bun"), "bun", { preserveInvocationPath: true })
    : "";
  const trustedHome = await resolveDirectory(process.env.HOME, "HOME");
  const wrapperCandidate =
    options.credentialWrapper ?? process.env.POSTIL_LOCAL_CREDENTIAL_WRAPPER;
  const credentialWrapper = wrapperCandidate
    ? await resolveExecutable(wrapperCandidate, "credential wrapper")
    : "";
  const trustedPath = [
    dirname(gitExecutable),
    dirname(jqExecutable),
    dirname(mktempExecutable),
    dirname(postilExecutable),
    ...(ghExecutable ? [dirname(ghExecutable)] : []),
    ...(secretsExecutable ? [dirname(secretsExecutable)] : []),
    ...(bunExecutable ? [dirname(bunExecutable)] : []),
    ...(credentialWrapper ? [dirname(credentialWrapper)] : []),
    "/usr/bin",
    "/bin",
  ].filter((entry, index, entries) => entries.indexOf(entry) === index).join(":");

  const template = await readFile(sourceHook, "utf8");
  const rendered = renderTemplate(template, {
    __POSTIL_EXECUTABLE__: postilExecutable,
    __GIT_EXECUTABLE__: gitExecutable,
    __GH_EXECUTABLE__: ghExecutable,
    __JQ_EXECUTABLE__: jqExecutable,
    __MKTEMP_EXECUTABLE__: mktempExecutable,
    __CREDENTIAL_WRAPPER__: credentialWrapper,
    __SECRETS_EXECUTABLE__: secretsExecutable,
    __TRUSTED_PATH__: trustedPath,
    __TRUSTED_HOME__: trustedHome,
  });

  await mkdir(dirname(targetHook), { recursive: true });
  const existingEntry = await lstat(targetHook).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existingEntry && !options.force) {
    let owned = false;
    if (existingEntry.isFile() && !existingEntry.isSymbolicLink()) {
      owned = (await readFile(targetHook, "utf8")).includes(installedMarker);
    }
    if (!owned) {
      throw new Error(
        `${targetHook} already exists; review it, then rerun with --force to replace the hook entry`,
      );
    }
  }

  const temporaryHook = join(dirname(targetHook), `.pre-push.postil-${randomUUID()}`);
  try {
    await writeFile(temporaryHook, rendered, { encoding: "utf8", mode: 0o755, flag: "wx" });
    await chmod(temporaryHook, 0o755);
    await rename(temporaryHook, targetHook);
  } finally {
    await rm(temporaryHook, { force: true }).catch(() => undefined);
  }
  return targetHook;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(placeholder, shellSingleQuotedContents(value));
  }
  const unresolved = rendered.match(/__[A-Z_]+__/);
  if (unresolved) throw new Error(`unresolved hook template placeholder: ${unresolved[0]}`);
  return rendered;
}

function shellSingleQuotedContents(value: string): string {
  return value.replaceAll("'", "'\"'\"'");
}

async function resolveExecutable(
  candidate: string | null | undefined,
  label: string,
  options: { preserveInvocationPath?: boolean } = {},
): Promise<string> {
  if (!candidate) throw new Error(`required executable is unavailable: ${label}`);
  if (!candidate.startsWith("/")) {
    throw new Error(`${label} executable must be an absolute path: ${candidate}`);
  }
  const resolved = await realpath(candidate);
  const metadata = await stat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error(`${label} executable is not an executable regular file: ${resolved}`);
  }
  return options.preserveInvocationPath ? candidate : resolved;
}

async function resolveDirectory(candidate: string | undefined, label: string): Promise<string> {
  if (!candidate?.startsWith("/")) throw new Error(`${label} must be an absolute directory`);
  const resolved = await realpath(candidate);
  if (!(await stat(resolved)).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const executable = Bun.which("git");
  if (!executable) throw new Error("required executable is unavailable: git");
  const result = await run(executable, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode})\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function run(
  executable: string,
  args: string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const unknown = args.filter(
      (arg) => arg !== "--force" && arg !== "--allow-delegated-hooks-path",
    );
    if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
    const target = await installLocalPostilHook(process.cwd(), {
      force: args.includes("--force"),
      allowDelegatedHooksPath: args.includes("--allow-delegated-hooks-path"),
    });
    console.log(`postil: installed trusted local pre-push hook at ${target}`);
    if (!process.env.POSTIL_LOCAL_CREDENTIAL_WRAPPER) {
      console.log(
        "postil: model credentials come from the push environment or, when absent, " +
          "`secrets --profile morgaesis get OPENROUTER_API_KEY`; refresh that profile's " +
          "authenticated session if local review reports an authentication error",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
