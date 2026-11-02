#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const hostAliases = new Map([["dsh", "deepseek-harness"]]);
const requestedHost = args[0] && !args[0].startsWith("--") ? args[0] : "deepseek-harness";
const host = hostAliases.get(requestedHost) ?? requestedHost;
const targetFlag = args.indexOf("--target");
const targetValue = targetFlag >= 0 ? args[targetFlag + 1] : undefined;
const skipMcp = args.includes("--skip-mcp");
const refresh = args.includes("--refresh");
const patch = args.includes("--patch");
const allowedHosts = new Set(["codex", "claude-code", "opencode", "deepseek-harness"]);

function printUsage() {
  process.stderr.write(
    "Usage: node scripts/setup.mjs [codex|claude-code|opencode|deepseek-harness|dsh] " +
    "[--target PATH] [--skip-mcp] [--refresh] [--patch]\n" +
    "  Host defaults to deepseek-harness when omitted.\n" +
    "  --patch writes .dsh/concept-loom.patch.yml for CLI launches instead of .dsh/mcp.json.\n",
  );
}

if (!allowedHosts.has(host) || (targetFlag >= 0 && (!targetValue || targetValue.startsWith("--")))) {
  printUsage();
  process.exit(2);
}
if (patch && host !== "deepseek-harness") {
  process.stderr.write("--patch is only supported for deepseek-harness.\n");
  process.exit(2);
}
if (patch && skipMcp) {
  process.stderr.write("--patch and --skip-mcp cannot be combined.\n");
  process.exit(2);
}

const target = resolve(targetValue ?? process.cwd());

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copyNew(source, destination) {
  if (await exists(destination)) {
    throw new Error(`refusing to overwrite existing path: ${destination}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true });
}

async function materializeTemplate(source, destination, replacements) {
  if (await exists(destination)) throw new Error(`refusing to overwrite existing file: ${destination}`);
  let text = await readFile(source, "utf8");
  for (const [needle, value] of Object.entries(replacements)) text = text.replaceAll(needle, value);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, text, "utf8");
}

function yamlSingleQuoted(value) {
  return value.replaceAll("'", "''");
}

async function installReference(skillDirectory) {
  const destination = join(skillDirectory, "references", "coaching-reference.md");
  await writeFile(destination, await readFile(join(projectRoot, "shared", "coaching-reference.md"), "utf8"), "utf8");
}

async function installSkill(source, destination) {
  if (!refresh) return copyNew(source, destination);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function installGuidance(source, preferredName, fallbackName) {
  const preferred = join(target, preferredName);
  if (await exists(preferred)) {
    await copyNew(source, join(target, fallbackName));
    return fallbackName;
  }
  await copyNew(source, preferred);
  return preferredName;
}

function runCodexMcp(args) {
  return spawnSync("codex", ["mcp", ...args], { encoding: "utf8" });
}

function registerCodexMcp() {
  if (skipMcp) {
    process.stdout.write("Skipped global Codex MCP registration (--skip-mcp).\n");
    return;
  }

  const serverPath = join(projectRoot, "src", "bridge.mjs");
  const current = runCodexMcp(["get", "concept-loom"]);
  if (current.error?.code === "ENOENT") {
    throw new Error("Codex CLI was not found on PATH. Install Codex or rerun with --skip-mcp.");
  }
  if (current.status === 0) {
    if (current.stdout.includes(serverPath)) {
      process.stdout.write("Codex MCP server 'concept-loom' is already registered with this installation.\n");
      return;
    }
    throw new Error(
      "a different Codex MCP server named 'concept-loom' already exists; " +
      "review it with `codex mcp get concept-loom`, then remove or rename it before retrying",
    );
  }

  const added = runCodexMcp(["add", "concept-loom", "--", "node", serverPath]);
  if (added.error?.code === "ENOENT") {
    throw new Error("Codex CLI was not found on PATH. Install Codex or rerun with --skip-mcp.");
  }
  if (added.status !== 0) {
    throw new Error(`failed to register Codex MCP server: ${(added.stderr || added.stdout).trim()}`);
  }
  process.stdout.write("Registered global Codex MCP server 'concept-loom'.\n");
}

async function installCodex() {
  const source = join(projectRoot, "adapters", "codex");
  const skillDestination = join(target, ".codex", "skills", "concept-coach");
  await installSkill(join(source, ".codex", "skills", "concept-coach"), skillDestination);
  await installReference(skillDestination);
  if (refresh) {
    process.stdout.write(`Refreshed Codex skill in ${skillDestination}\n`);
    registerCodexMcp();
    process.stdout.write(`\nStart a new Codex session from the learning workspace:\n  cd ${JSON.stringify(target)}\n  codex\n`);
    return;
  }
  const guidance = await installGuidance(join(source, "AGENTS.md"), "AGENTS.md", "CONCEPT_LOOM_AGENTS.md");
  process.stdout.write(`Installed Codex skill in ${skillDestination}\n`);
  if (guidance !== "AGENTS.md") process.stdout.write("Merge CONCEPT_LOOM_AGENTS.md into your existing AGENTS.md.\n");
  registerCodexMcp();
  process.stdout.write(`\nStart a new Codex session from the learning workspace:\n  cd ${JSON.stringify(target)}\n  codex\n`);
}

async function installClaude() {
  const source = join(projectRoot, "adapters", "claude-code");
  const skillDestination = join(target, ".claude", "skills", "concept-coach");
  await installSkill(join(source, ".claude", "skills", "concept-coach"), skillDestination);
  await installReference(skillDestination);
  if (refresh) {
    process.stdout.write(`Refreshed Claude Code skill in ${skillDestination}\n`);
    return;
  }
  await copyNew(join(source, ".claude", "agents"), join(target, ".claude", "agents"));
  const guidance = await installGuidance(join(source, "CLAUDE.md"), "CLAUDE.md", "CONCEPT_LOOM_CLAUDE.md");
  await materializeTemplate(join(source, ".mcp.json.template"), join(target, ".mcp.json"), {
    __SERVER_PATH__: join(projectRoot, "src", "bridge.mjs"),
  });
  process.stdout.write(`Installed Claude Code assets in ${target}\n`);
  if (guidance !== "CLAUDE.md") process.stdout.write("Merge CONCEPT_LOOM_CLAUDE.md into your existing CLAUDE.md.\n");
}

async function installOpenCode() {
  const source = join(projectRoot, "adapters", "opencode");
  const skillDestination = join(target, ".opencode", "skills", "concept-coach");
  await installSkill(join(source, ".opencode", "skills", "concept-coach"), skillDestination);
  await installReference(skillDestination);
  if (refresh) {
    process.stdout.write(`Refreshed OpenCode skill in ${skillDestination}\n`);
    return;
  }
  await copyNew(join(source, ".opencode", "agents"), join(target, ".opencode", "agents"));
  const guidance = await installGuidance(join(source, "AGENTS.md"), "AGENTS.md", "CONCEPT_LOOM_AGENTS.md");
  await materializeTemplate(join(source, "opencode.json.template"), join(target, "opencode.json"), {
    __SERVER_PATH__: join(projectRoot, "src", "bridge.mjs"),
  });
  process.stdout.write(`Installed OpenCode assets in ${target}\n`);
  if (guidance !== "AGENTS.md") process.stdout.write("Merge CONCEPT_LOOM_AGENTS.md into your existing AGENTS.md.\n");
}

async function findGitRootAbove(directory) {
  let current = dirname(resolve(directory));
  for (;;) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function workspaceMcpEntry(serverPath) {
  return {
    type: "stdio",
    command: "node",
    args: [serverPath],
    // dsh-workspace-mcp resolves cwd relative to this file, which lives in .dsh.
    // ".." is therefore the learning workspace root, not the hidden config folder.
    cwd: "..",
  };
}

function entryTargetsServer(entry, serverPath) {
  if (!entry || typeof entry !== "object") return false;
  const entryArgs = Array.isArray(entry.args) ? entry.args : [];
  return entryArgs.some(
    (arg) => typeof arg === "string" && resolve(arg).toLowerCase() === resolve(serverPath).toLowerCase(),
  );
}

async function upsertWorkspaceMcp(serverPath) {
  const destination = join(target, ".dsh", "mcp.json");
  let config = { mcpServers: {} };

  if (await exists(destination)) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(destination, "utf8"));
    } catch {
      throw new Error(`${destination} is not valid JSON; fix it before installing Concept Loom`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${destination} must contain a JSON object`);
    }
    const servers = parsed.mcpServers ?? {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      throw new Error(`${destination}: mcpServers must be a JSON object`);
    }
    config = { ...parsed, mcpServers: servers };
    const existing = servers["concept-loom"];
    if (existing && !entryTargetsServer(existing, serverPath)) {
      throw new Error(
        `${destination} already declares a different 'concept-loom' server; ` +
        "remove or rename it before installing Concept Loom",
      );
    }
    if (existing && !refresh) {
      process.stdout.write(`Workspace MCP server 'concept-loom' is already configured in ${destination}\n`);
      return;
    }
  }

  config.mcpServers["concept-loom"] = workspaceMcpEntry(serverPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  process.stdout.write(`Configured workspace MCP server 'concept-loom' in ${destination}\n`);
}

async function hasWorkspaceMcpPlugin() {
  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
  const profilesDirectory = join(dshHome, "profiles");
  let profileNames;
  try {
    profileNames = await readdir(profilesDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  for (const name of profileNames) {
    const profileDirectory = join(profilesDirectory, name);
    try {
      const packageJson = JSON.parse(await readFile(join(profileDirectory, "package.json"), "utf8"));
      const bundles = packageJson?.dsh?.profile?.bundles;
      const dependencies = packageJson?.dependencies;
      if (Array.isArray(bundles) && bundles.some((entry) => String(entry).includes("workspace-mcp"))) return true;
      if (dependencies && Object.keys(dependencies).some((entry) => entry.includes("workspace-mcp"))) return true;
    } catch {
      // A profile without package.json or with invalid JSON does not prove the plugin is absent.
    }
    try {
      const patchText = await readFile(join(profileDirectory, "cordis.patch.yml"), "utf8");
      if (/workspace-mcp/.test(patchText)) return true;
    } catch {
      // No patch file in this profile.
    }
  }
  return false;
}

async function installDeepSeekHarness() {
  const source = join(projectRoot, "adapters", "deepseek-harness");
  const skillDestination = join(target, ".dsh", "skills", "concept-coach");
  await installSkill(join(source, ".dsh", "skills", "concept-coach"), skillDestination);
  await installReference(skillDestination);

  if (refresh) {
    process.stdout.write(`Refreshed DeepSeek Harness skill in ${skillDestination}\n`);
  } else {
    const guidance = await installGuidance(join(source, "AGENTS.md"), "AGENTS.md", "CONCEPT_LOOM_AGENTS.md");
    process.stdout.write(`Installed DeepSeek Harness skill in ${skillDestination}\n`);
    if (guidance !== "AGENTS.md") process.stdout.write("Merge CONCEPT_LOOM_AGENTS.md into your existing AGENTS.md.\n");
  }

  const gitRoot = await findGitRootAbove(target);
  if (gitRoot) {
    process.stdout.write(
      `\nWarning: ${target} is inside the Git repository ${gitRoot}.\n` +
      "DeepSeek Harness discovers project skills at the Git root, so it will not see " +
      `${join(target, ".dsh", "skills")}.\n` +
      `Run setup at ${gitRoot} or make this learning folder its own project.\n`,
    );
  }

  const serverPath = join(projectRoot, "src", "bridge.mjs");

  if (skipMcp) {
    process.stdout.write("Skipped MCP configuration (--skip-mcp).\n");
    process.stdout.write(`\nOpen a NEW session in this workspace and ask:\n  /concept-coach\n`);
    return;
  }

  if (patch) {
    const patchDestination = join(target, ".dsh", "concept-loom.patch.yml");
    const content = (await readFile(join(source, "concept-loom.patch.yml.template"), "utf8"))
      .replaceAll("__SERVER_PATH__", yamlSingleQuoted(serverPath));
    if (await exists(patchDestination)) {
      if (!refresh) throw new Error(`refusing to overwrite existing file: ${patchDestination}`);
      await writeFile(patchDestination, content, "utf8");
    } else {
      await mkdir(dirname(patchDestination), { recursive: true });
      await writeFile(patchDestination, content, "utf8");
    }
    process.stdout.write(`Created CLI patch ${patchDestination}\n`);
    process.stdout.write(
      `\nStart DeepSeek Harness with Concept Loom:\n` +
      `  cd ${JSON.stringify(target)}\n` +
      `  npx @deepseek-ai/dsh --profile web --patch .dsh/concept-loom.patch.yml\n` +
      "Do not combine this patch with the dsh-workspace-mcp plugin in the same session.\n",
    );
    return;
  }

  await upsertWorkspaceMcp(serverPath);

  if (await hasWorkspaceMcpPlugin()) {
    process.stdout.write("Detected the dsh-workspace-mcp plugin in a DSH profile.\n");
  } else {
    process.stdout.write(
      "\nNote: .dsh/mcp.json is loaded by the dsh-workspace-mcp plugin, which was not found in any DSH profile.\n" +
      "Install it once in the DSH Plugin Manager, or run:\n" +
      "  dsh plugin --profile desktop add dsh-workspace-mcp\n" +
      "Without it, the skill loads but the loom_* tools are unavailable in the Desktop GUI.\n",
    );
  }

  if (await exists(join(target, ".dsh", "concept-loom.patch.yml"))) {
    process.stdout.write(
      "Found an older .dsh/concept-loom.patch.yml; do not use --patch together with dsh-workspace-mcp.\n",
    );
  }

  process.stdout.write(
    `\nOpen a NEW session in this workspace and ask:\n  /concept-coach\n` +
    "Existing sessions do not reload project MCP configuration.\n",
  );
}

try {
  await mkdir(target, { recursive: true });
  if (host === "codex") await installCodex();
  if (host === "claude-code") await installClaude();
  if (host === "opencode") await installOpenCode();
  if (host === "deepseek-harness") await installDeepSeekHarness();
} catch (error) {
  process.stderr.write(`Setup stopped: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
