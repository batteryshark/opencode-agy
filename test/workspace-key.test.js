import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, linkSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { workspaceDirName, prepareWorkspace, writeMcpConfig } from "../src/workspace.js";
import { sessionKeyFromHeaders } from "../src/server.js";

const fixture = () => mkdtempSync(join(tmpdir(), "workspace-key-"));
const prepare = (baseDir, key = "key", systemPrompt = "synthetic prompt") =>
  prepareWorkspace({ baseDir, key, systemPrompt, cwd: "/synthetic/project" });

test("exact complete keys have stable disjoint names, including UTF-16 edge cases", () => {
  const keys = ["", "default", ".", "..", "../escape", "/absolute", "a/b", "a:b", "a\\b", "a_b",
    "a".repeat(200) + "x", "a".repeat(200) + "y", "é", "e\u0301", "😀", "\ud800", "\ud801", "\udc00", "�",
    "\\ud800", " key", "key", "key ", "\0"];
  const names = keys.map(workspaceDirName);
  assert.equal(new Set(names).size, keys.length);
  for (let i = 0; i < keys.length; i++) {
    assert.match(names[i], /^workspace-v2-sha256-[a-f0-9]{64}$/);
    assert.ok(names[i].length > 80, "cannot overlap any legacy sanitized name");
    for (let repeat = 0; repeat < 20; repeat++) assert.equal(workspaceDirName(keys[i]), names[i]);
  }
  for (const value of [undefined, null, 1, false, {}, [], new String("key"), Symbol("key")]) {
    assert.throws(() => workspaceDirName(value), TypeError);
  }
});

test("API session header normalization stays unchanged", () => {
  assert.equal(sessionKeyFromHeaders({ "x-opencode-session-id": " key " }), "key");
  assert.equal(sessionKeyFromHeaders({ "x-opencode-session-id": [" a:b ", "other"] }), "a:b");
  assert.equal(sessionKeyFromHeaders({ "x-opencode-session-id": "x".repeat(201) }), "x".repeat(200));
  assert.equal(sessionKeyFromHeaders({ "x-opencode-session-id": 2, "x-session-id": "fallback" }), "fallback");
});

test("prepare and MCP writes are contained, repeatable and preserve legacy bytes", () => {
  const root = fixture();
  const base = join(root, "sessions");
  mkdirSync(join(base, "team_a"), { recursive: true });
  writeFileSync(join(base, "team_a", "sentinel"), "legacy private state");
  writeFileSync(join(root, "sessions.json"), '{"old":"synthetic-conversation"}');
  for (const key of ["team/a", "team:a", "..", ".", "../escape", "/absolute", "", "x".repeat(400), "\ud800", "\ud801"]) {
    const a = prepare(base, key);
    assert.equal(relative(base, a.dir), workspaceDirName(key));
    assert.equal(prepare(base, key).agentChanged, false);
    assert.equal(a.agentChanged, true);
    assert.equal(prepare(base, key, "new prompt").agentChanged, true);
    const text = readFileSync(join(a.dir, ".agents/agents/bridge.md"), "utf8");
    assert.ok(text.startsWith("---\n")); // changed writes must start at byte zero
    assert.ok(text.includes("new prompt"));
    writeMcpConfig({ dir: a.dir, key, baseDir: base, socketPath: "/synthetic/socket", gen: 3 });
    assert.equal(JSON.parse(readFileSync(join(a.dir, ".agents/mcp_config.json"))).mcpServers.harness.env.OPENCODE_AGY_SESSION, key);
    assert.ok(lstatSync(join(a.dir, ".git")).isDirectory());
  }
  assert.equal(readFileSync(join(base, "team_a/sentinel"), "utf8"), "legacy private state");
  assert.equal(readFileSync(join(root, "sessions.json"), "utf8"), '{"old":"synthetic-conversation"}');
  assert.deepEqual(readdirSync(root).sort(), ["sessions", "sessions.json"]);
});

test("MCP rejects arbitrary directories, wrong keys and wrong configured root before writes", () => {
  const base = join(fixture(), "sessions");
  const { dir } = prepare(base);
  for (const candidate of [base, join(base, ".."), join(base, "legacy"), dir + "/..", undefined]) {
    assert.throws(() => writeMcpConfig({ dir: candidate, key: "key", baseDir: base }), /does not match/);
  }
  assert.throws(() => writeMcpConfig({ dir, key: "other", baseDir: base }), /does not match/);
  assert.throws(() => writeMcpConfig({ dir, key: "key" }), /does not match/);
  for (const baseDir of [null, {}, "", 4]) assert.throws(() => prepare(baseDir), TypeError);
  for (const key of [null, {}, 4]) assert.throws(() => prepare(base, key), TypeError);
});

test("reject symlink root ancestors, destinations and all managed components before writes", () => {
  for (const component of ["ancestor", "root", "workspace", ".git", ".agents", ".agents/agents", ".agents/agents/bridge.md", ".agents/hooks.json", ".agents/mcp_config.json"]) {
    for (const dangling of [false, true]) {
      const scratch = fixture();
      const outside = join(scratch, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "sentinel"), "unchanged");
      const base = join(scratch, "parent/sessions");
      const dir = join(base, workspaceDirName("key"));
      const link = component === "ancestor" ? join(scratch, "parent") : component === "root" ? base :
        component === "workspace" ? dir : join(dir, component);
      mkdirSync(join(link, ".."), { recursive: true });
      symlinkSync(dangling ? join(outside, "missing") : outside, link);
      assert.throws(() => prepare(base), /Unsafe workspace/);
      assert.throws(() => writeMcpConfig({ dir, key: "key", baseDir: base }), /Unsafe workspace/);
      assert.deepEqual(readdirSync(outside), ["sentinel"]);
      assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "unchanged");
    }
  }
});

test("reject symlink replacement after prepare, non-regular files and hardlinks", () => {
  const scratch = fixture();
  const base = join(scratch, "sessions");
  const { dir } = prepare(base);
  const target = join(scratch, "outside-file");
  writeFileSync(target, "do not overwrite");
  symlinkSync(target, join(dir, ".agents/mcp_config.json"));
  assert.throws(() => writeMcpConfig({ dir, key: "key", baseDir: base }), /Unsafe workspace/);
  for (const hard of [false, true]) {
    const base2 = join(scratch, hard ? "hard" : "nonregular");
    const file = join(base2, workspaceDirName("key"), ".agents/agents/bridge.md");
    mkdirSync(join(file, ".."), { recursive: true });
    if (hard) linkSync(target, file);
    else mkdirSync(file);
    assert.throws(() => prepare(base2), /Unsafe workspace/);
  }
  assert.equal(readFileSync(target, "utf8"), "do not overwrite");
});
