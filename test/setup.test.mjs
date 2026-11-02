import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupScript = join(projectRoot, "scripts", "setup.mjs");
const bridgePath = join(projectRoot, "src", "bridge.mjs");

function runSetup(args) {
  return spawnSync(process.execPath, [setupScript, ...args], { encoding: "utf8" });
}

async function temporaryTarget(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("DeepSeek Harness installer creates a skill and workspace MCP config", async () => {
  const target = await temporaryTarget("concept-loom-dsh-");
  const result = runSetup(["deepseek-harness", "--target", target]);

  assert.equal(result.status, 0, result.stderr);
  const skill = await readFile(join(target, ".dsh", "skills", "concept-coach", "SKILL.md"), "utf8");
  const reference = await readFile(join(target, ".dsh", "skills", "concept-coach", "references", "coaching-reference.md"), "utf8");
  const mcp = JSON.parse(await readFile(join(target, ".dsh", "mcp.json"), "utf8"));
  await stat(join(target, "AGENTS.md"));

  assert.match(skill, /name: concept-coach/);
  assert.match(reference, /# Connection-first coaching reference/);
  assert.deepEqual(mcp, {
    mcpServers: {
      "concept-loom": {
        type: "stdio",
        command: "node",
        args: [bridgePath],
        cwd: "..",
      },
    },
  });
  await assert.rejects(stat(join(target, ".dsh", "concept-loom.patch.yml")), { code: "ENOENT" });
});

test("DeepSeek Harness accepts the dsh alias and omitting --target", async () => {
  const target = await temporaryTarget("concept-loom-dsh-alias-");
  const result = spawnSync(process.execPath, [setupScript, "dsh"], {
    cwd: target,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const mcp = JSON.parse(await readFile(join(target, ".dsh", "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers["concept-loom"].command, "node");
});

test("DeepSeek Harness --skip-mcp installs only workspace guidance", async () => {
  const target = await temporaryTarget("concept-loom-dsh-skip-");
  const result = runSetup(["deepseek-harness", "--target", target, "--skip-mcp"]);

  assert.equal(result.status, 0, result.stderr);
  await stat(join(target, ".dsh", "skills", "concept-coach", "SKILL.md"));
  await assert.rejects(stat(join(target, ".dsh", "mcp.json")), { code: "ENOENT" });
  await assert.rejects(stat(join(target, ".dsh", "concept-loom.patch.yml")), { code: "ENOENT" });
});

test("DeepSeek Harness --patch writes a CLI patch instead of mcp.json", async () => {
  const target = await temporaryTarget("concept-loom-dsh-patch-");
  const result = runSetup(["deepseek-harness", "--target", target, "--patch"]);

  assert.equal(result.status, 0, result.stderr);
  const patch = await readFile(join(target, ".dsh", "concept-loom.patch.yml"), "utf8");
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(patch, new RegExp(bridgePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(patch, /__SERVER_PATH__/);
  await assert.rejects(stat(join(target, ".dsh", "mcp.json")), { code: "ENOENT" });
});

test("DeepSeek Harness merges the workspace MCP entry without dropping other servers", async () => {
  const target = await temporaryTarget("concept-loom-dsh-merge-");
  await mkdir(join(target, ".dsh"), { recursive: true });
  const otherServer = { command: "node", args: ["other.mjs"], cwd: "." };
  await writeFile(
    join(target, ".dsh", "mcp.json"),
    `${JSON.stringify({ mcpServers: { other: otherServer } }, null, 2)}\n`,
    "utf8",
  );

  const result = runSetup(["deepseek-harness", "--target", target]);
  assert.equal(result.status, 0, result.stderr);
  const mcp = JSON.parse(await readFile(join(target, ".dsh", "mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.other, otherServer);
  assert.deepEqual(mcp.mcpServers["concept-loom"].args, [bridgePath]);
});

test("DeepSeek Harness --refresh restores the workspace MCP entry", async () => {
  const target = await temporaryTarget("concept-loom-dsh-refresh-");
  const first = runSetup(["deepseek-harness", "--target", target]);
  assert.equal(first.status, 0, first.stderr);

  const file = join(target, ".dsh", "mcp.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  const otherServer = { command: "node", args: ["other.mjs"], cwd: "." };
  config.mcpServers.other = otherServer;
  delete config.mcpServers["concept-loom"];
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const refreshed = runSetup(["deepseek-harness", "--target", target, "--refresh"]);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const mcp = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(mcp.mcpServers.other, otherServer);
  assert.deepEqual(mcp.mcpServers["concept-loom"].args, [bridgePath]);
});

test("DeepSeek Harness refuses to replace a different concept-loom server", async () => {
  const target = await temporaryTarget("concept-loom-dsh-conflict-");
  await mkdir(join(target, ".dsh"), { recursive: true });
  await writeFile(
    join(target, ".dsh", "mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        "concept-loom": { command: "node", args: ["C:/other/bridge.mjs"], cwd: "." },
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const result = runSetup(["deepseek-harness", "--target", target]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different 'concept-loom'/);
});
