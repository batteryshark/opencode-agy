import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AgyProcess } from "../src/agy-process.js";

test("idle termination is bounded, TERM-only, does not close stdin or lose owned identity", async () => {
  const signals = [];
  const child = new EventEmitter();
  // No PID: group signal cannot target any real process; fallback records signal.
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = (s) => { signals.push(s); return true; };
  const p = new AgyProcess({ cwd: ".", onItem() {}, spawnImpl: () => child });
  p.start();
  assert.equal(await p.releaseIdle(20), false);
  assert.equal(p.child, child); assert.equal(p.exited, false);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(p._exitWaiters.length, 0);
  assert.equal(await p.releaseIdle(20), false);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(signals, ["SIGTERM"]);
  child.emit("exit", 0, null);
  assert.equal(p.exited, true);
});
