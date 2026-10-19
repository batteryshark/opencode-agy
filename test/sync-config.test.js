import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfigPath, generateModels, updateConfig, configDiff, syncConfig } from "../src/sync-config.js";

const known = { name: "Synthetic custom name", limit: { context: 12345, output: 1234 }, settings: { custom: "keep" } };
const models = [
  { id: "synthetic-existing", name: "Synthetic existing" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];
function original(legacy = false) {
  return `{
  "plugins": ["keep this"],
  "${legacy ? "provider" : "providers"}": {
    "other": {"models":{"fake":{}},"text":${JSON.stringify('escaped " models { }')}},
    "agy": {
      "${legacy ? "options" : "settings"}": {"baseURL":"http://synthetic.invalid/v1"},
      "models": {
        "synthetic-existing": ${JSON.stringify(known)},
        "retired-model": {"name":"old"}
      }
    }
  }
}
`;
}

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy" : "V2"}: exact new capability shape, overrides, pruning, unrelated bytes and no-op`, () => {
    const before = original(legacy);
    const after = updateConfig(before, models);
    const root = legacy ? "provider" : "providers";
    const config = JSON.parse(after);
    const result = config[root].agy.models;
    assert.deepEqual(result["synthetic-existing"], known);
    assert.deepEqual(result["gpt-oss-120b-medium"], {
      name: "GPT-OSS 120B Medium (agy)",
      ...(legacy ? { tool_call: true } : { capabilities: { tools: true, input: ["text"], output: ["text"] } }),
      limit: { context: 131072, output: 32768 },
    });
    assert.ok(!Object.hasOwn(result, "retired-model"));
    assert.deepEqual(config[root].other, JSON.parse(before)[root].other);
    assert.equal(after.slice(0, after.indexOf('"models": {\n')), before.slice(0, before.indexOf('"models": {\n')));
    assert.equal(after.slice(after.lastIndexOf("\n      }")), before.slice(before.lastIndexOf("\n      }")));
    assert.equal(updateConfig(after, [...models].reverse()), after);
    assert.equal(configDiff(before, after), "agy models: 1 added, 1 removed, 1 retained (values omitted)\n");
    assert.equal(configDiff(after, after), "");
    for (const text of [JSON.stringify(JSON.parse(before)), before.replace(/\n/g, "\r\n")]) {
      const updated = updateConfig(text, models);
      assert.deepEqual(JSON.parse(updated), config);
      if (text.includes("\r\n")) assert.ok(!/(?<!\r)\n/.test(updated));
      assert.equal(updateConfig(updated, models), updated);
    }
  });
}

const malformed = [
  "{}", "null", "[]", '{ // JSONC\n}',
  '{"providers":{"agy":{"models":{},"settings":{}}},"provider":{"agy":{"models":{},"options":{}}}}',
  '{"providers":{"agy":null}}',
  '{"providers":{"agy":{"models":[],"settings":{}}}}',
  '{"providers":{"agy":{"models":{"synthetic-existing":null},"settings":{}}}}',
  '{"providers":{"agy":{"models":{},"options":{}}}}',
  '{"provider":{"agy":{"models":{},"settings":{}}}}',
  '{"providers":{"agy":{"models":{},"settings":{},"options":{}}}}',
  '{"providers":{"agy":{"models":{},"settings":null}}}',
  '{"providers":{"agy":{"models":{},"settings":{"baseURL":4}}}}',
  '{"providers":{"agy":{"models":{},"models":{},"settings":{}}}}',
  '{"providers":{"agy":{"models":{},"mod\\u0065ls":{},"settings":{}}}}',
  '{"providers":{"agy":{"models":{"keep":{"settings":{"key":1,"k\\u0065y":2}}},"settings":{}}}}',
  '{"providers":{"agy":{"models":{},"settings":{}}},"providers":{"other":{}}}',
];

test("malformed, mixed and duplicate config layouts refuse; inventories never guess private families", () => {
  for (const text of malformed) assert.throws(() => updateConfig(text, models));
  for (const data of [[], null, [{ id: "unknown-new-family", name: "Unknown" }], [models[0], models[0]], [{ id: "__proto__" }], [{ id: "bad/id" }], [{ id: "gpt-oss-120b-medium" }]]) {
    assert.throws(() => updateConfig(original(), data));
  }
  assert.throws(() => generateModels([{ id: "unknown-new-family" }], {}), /add an explicit model entry with verified limits/);
  const text = '{"providers":{"agy":{"models":{"custom":{"modelID":"custom","limit":{"context":42},"headers":{"X-Synthetic":"keep"}}},"settings":{}}}}';
  assert.equal(updateConfig(text, [{ id: "custom" }]), text);
  assert.equal(defaultConfigPath(), join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, ".config"), "opencode", "opencode.json"));
});

test("mocked fetch: both path layouts, dry-run, backup, permissions, prune and no-op", async (t) => {
  for (const legacy of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "agy-sync-offline-"));
    const path = join(dir, "opencode.json");
    const before = original(legacy);
    writeFileSync(path, before); chmodSync(path, 0o600);
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push([url.href, options]);
      return { ok: true, json: async () => ({ data: models }) };
    });
    const preview = await syncConfig({ path, token: "synthetic-test-token", dryRun: true });
    assert.equal(preview.changed, true); assert.equal(preview.backup, null);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["opencode.json"]);
    assert.equal(calls[0][0], "http://synthetic.invalid/v1/models");
    assert.deepEqual(calls[0][1].headers, { Authorization: "Bearer synthetic-test-token" });
    assert.equal(calls[0][1].redirect, "error");
    assert.ok(calls[0][1].signal instanceof AbortSignal);
    const applied = await syncConfig({ path });
    assert.equal(applied.changed, true);
    assert.equal(readFileSync(applied.backup, "utf8"), before);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(applied.backup).mode & 0o777, 0o600);
    const noop = await syncConfig({ path, baseURL: "https://override.invalid/v1/" });
    assert.deepEqual(noop, { diff: "", backup: null, changed: false });
    assert.equal(calls.at(-1)[0], "https://override.invalid/v1/models");
    assert.equal(readdirSync(dir).length, 2);
  }
});

test("refusals never partially write; malformed configs are rejected before fetch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agy-sync-refusal-"));
  const path = join(dir, "opencode.json");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected fetch"); });
  for (const before of malformed) {
    writeFileSync(path, before);
    await assert.rejects(syncConfig({ path }));
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["opencode.json"]);
  }
  assert.equal(calls, 0);
  writeFileSync(path, original());
  await assert.rejects(syncConfig({ path, baseURL: "file:///synthetic" }), /HTTP or HTTPS/);
  assert.equal(calls, 0);
  for (const response of [
    { ok: false, status: 503 },
    { ok: true, json: async () => { throw new Error("invalid response JSON"); } },
    { ok: true, json: async () => ({ data: [] }) },
    { ok: true, json: async () => ({ data: [...models, { id: "unknown-new-family", name: "Unknown" }] }) },
  ]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(syncConfig({ path }));
    assert.equal(readFileSync(path, "utf8"), original());
    assert.deepEqual(readdirSync(dir), ["opencode.json"]);
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("synthetic network failure"); });
  await assert.rejects(syncConfig({ path }), /bridge \/models fetch failed/);
  assert.equal(readFileSync(path, "utf8"), original());
  t.mock.method(globalThis, "fetch", async () => {
    writeFileSync(path, original() + "\n");
    return { ok: true, json: async () => ({ data: models }) };
  });
  await assert.rejects(syncConfig({ path }), /config changed during sync/);
  assert.equal(readFileSync(path, "utf8"), original() + "\n");
  assert.deepEqual(readdirSync(dir), ["opencode.json"]);
  await assert.rejects(syncConfig({ path: dir }), /regular single-link/);
});

test("raw retained VALUE bytes and safe output: both schemas, minified/formatted CRLF, prune/add/apply/no-op", async (t) => {
  const outside = "SYNTHETIC-OUTSIDE-SECRET";
  const inside = "SYNTHETIC-SETTINGS-SECRET";
  const header = "SYNTHETIC-HEADERS-SECRET";
  for (const legacy of [false, true]) for (const formatted of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "agy-sync-fidelity-"));
    const path = join(dir, "opencode.json");
    const nl = formatted ? "\r\n" : "";
    const raw = `{${nl}"settings":{"counter":9007199254740993,"huge":1e400,"fraction":0.123456789012345678901234567890,"minusZero":-0,"tiny":-1e-400,"nested":[{"escaped\\u004bey":[9007199254740993,1e400,0.123456789012345678901234567890,-0]}],"apiKey":"${inside}"},${nl}"headers":{"Authorization":"${header}"},"text":"escaped \\\" { [ ] }"}`;
    // Escaped map/model keys and a removed arbitrary ID must not reach stdout.
    const prefix = `{${nl}"unrelated":{"apiKey":"${outside}"},${nl}"${legacy ? "provider" : "providers"}":{"agy":{"${legacy ? "options" : "settings"}":{},${nl}"mod\\u0065ls":`;
    const suffix = `}},"tail":[{"apiKey":"${outside}"}]}${nl}`;
    const removedID = "SYNTHETIC-ID-SECRET\u001b[31m\r\nforged";
    const before = prefix + `{"k\\u0065ep":${raw},${JSON.stringify(removedID)}:{"settings":{"apiKey":"${inside}"}}}` + suffix;
    const inventory = [{ id: "keep" }, models[1]];
    const generated = JSON.stringify({
      name: "GPT-OSS 120B Medium (agy)",
      ...(legacy ? { tool_call: true } : { capabilities: { tools: true, input: ["text"], output: ["text"] } }),
      limit: { context: 131072, output: 32768 },
    }, null, "  ").replace(/\n/g, `${formatted ? "\r\n" : "\n"}  `);
    const newline = formatted ? "\r\n" : "\n";
    const expected = prefix + `{${newline}  "keep": ${raw},${newline}  "gpt-oss-120b-medium": ${generated}${newline}}` + suffix;
    writeFileSync(path, before); chmodSync(path, 0o600);
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ data: inventory }) }));
    const summary = "agy models: 1 added, 1 removed, 1 retained (values omitted)\n";
    const preview = await syncConfig({ path, dryRun: true });
    assert.deepEqual(preview, { diff: summary, backup: null, changed: true });
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["opencode.json"]);
    const applied = await syncConfig({ path });
    assert.equal(applied.diff, summary);
    assert.equal(readFileSync(path, "utf8"), expected);
    assert.equal(readFileSync(applied.backup, "utf8"), before);
    assert.deepEqual(readdirSync(dir).sort(), ["opencode.json", applied.backup.slice(dir.length + 1)].sort());
    const snapshot = readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]);
    for (const dryRun of [true, false]) {
      const noop = await syncConfig({ path, dryRun });
      assert.deepEqual(noop, { diff: "", backup: null, changed: false });
      assert.deepEqual(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]), snapshot);
      for (const result of [preview, applied, noop]) {
        // This is precisely the returned text written by the CLI, without activation.
        const output = (result.diff || "agy models are already in sync\n") +
          (result.backup ? `backup: ${result.backup}\n` : result.changed ? "dry run: config unchanged; no backup created\n" : "");
        for (const secret of [outside, inside, header, "SYNTHETIC-ID-SECRET"]) assert.ok(!output.includes(secret));
        assert.ok(!output.includes("\u001b"));
      }
    }
    assert.equal(updateConfig(expected, inventory.slice().reverse()), expected);
  }
});

test("failure diagnostics omit config/response snippets, credentials and invalid model IDs", async (t) => {
  const secret = "SYNTHETIC-DIAGNOSTIC-SECRET";
  const dir = mkdtempSync(join(tmpdir(), "agy-sync-private-errors-"));
  const path = join(dir, "opencode.json");
  let calls = 0;
  const checkFailure = async (before, response) => {
    writeFileSync(path, before);
    t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
    await assert.rejects(syncConfig({ path }), (err) => {
      assert.ok(!err.message.includes(secret));
      assert.ok(!err.message.includes("\u001b"));
      return true;
    });
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["opencode.json"]);
  };
  for (const bad of [`{"apiKey":"${secret}",`, `{"providers":{"agy":{"models":{},"settings":{"baseURL":"${secret}"}}}}`]) {
    await checkFailure(bad, () => { throw new Error(secret); });
  }
  assert.equal(calls, 0);
  await checkFailure(original(), () => { throw new Error(secret); });
  await checkFailure(original(), () => ({ ok: true, json: async () => { throw new Error(secret); } }));
  for (const id of [`${secret}\u001b[31m`, secret]) {
    await checkFailure(original(), () => ({ ok: true, json: async () => ({ data: [{ id }] }) }));
  }
});
