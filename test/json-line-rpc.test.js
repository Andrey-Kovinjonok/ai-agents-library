import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonLinePeer, spawnJsonLinePeer } from "../src/json-line-rpc.js";

function pair(t, handler) {
  const a = new PassThrough(), b = new PassThrough();
  const client = new JsonLinePeer(a, b);
  const server = new JsonLinePeer(b, a, { handler });
  t.after(() => { client.close(); server.close(); a.destroy(); b.destroy(); });
  return { client, server, a, b };
}

test("responses use ids, handler errors and notifications are distinct", async t => {
  const received = [];
  const { client } = pair(t, async (method, params) => {
    if (method === "bad") throw new Error("expected failure");
    if (method === "notice") { received.push(params); return; }
    await new Promise(resolve => setTimeout(resolve, params.delay));
    return params.value;
  });
  assert.deepEqual(await Promise.all([
    client.request("echo", { value: "slow", delay: 15 }),
    client.request("echo", { value: "fast", delay: 0 }),
  ]), ["slow", "fast"]);
  await assert.rejects(client.request("bad"), /expected failure/);
  client.notify("notice", { value: 7 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [{ value: 7 }]);
});

test("timeout and closed input reject pending calls", async t => {
  const { client, a } = pair(t, () => new Promise(() => {}));
  await assert.rejects(client.request("wait", {}, { timeoutMs: 15 }), /timed out/);
  const pending = client.request("wait");
  a.end();
  await assert.rejects(pending, /closed/);
});

test("malformed and oversized messages cannot leave calls hanging", async () => {
  for (const text of ["not json\n", "x".repeat(129)]) {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new JsonLinePeer(input, output, { maxMessageBytes: 128 });
    const pending = peer.request("test");
    input.write(text);
    await assert.rejects(pending, /Invalid|large/);
    peer.close(); input.destroy(); output.destroy();
  }
});

test("owned subprocess handles requests and closes; no inherited environment", async () => {
  const script = 'process.stdin.setEncoding("utf8"); process.stdin.on("data", s => { for (const l of s.trim().split("\\n")) { const m=JSON.parse(l); if(m.id) process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:process.env.RPC_TEST_SECRET ?? "clean"})+"\\n"); }});';
  const child = spawnJsonLinePeer(process.execPath, ["-e", script], { cwd: process.cwd(), env: {} });
  try { assert.equal(await child.peer.request("test"), "clean"); }
  finally { await child.close(); }
  assert.ok(child.process.exitCode !== null || child.process.signalCode !== null);
});

test("missing executable fails pending request and close settles", async () => {
  const child = spawnJsonLinePeer("/nonexistent/agent-rpc-executable", [], { cwd: process.cwd(), env: {} });
  await assert.rejects(child.peer.request("test"), /ENOENT/);
  await child.close();
});
