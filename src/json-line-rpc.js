import { spawn } from "node:child_process";

/** JSON-RPC transport only. No knowledge of products, projects or indexes. */
export class JsonLinePeer {
  constructor(input, output, { handler, maxMessageBytes = 16 * 1024 * 1024 } = {}) {
    this.input = input;
    this.output = output;
    this.handler = handler;
    this.maxMessageBytes = maxMessageBytes;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.onData = chunk => this.receive(chunk);
    this.onEnd = () => this.close(new Error("JSON-RPC input closed"));
    this.onError = error => this.close(error);
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("close", this.onEnd);
    input.on("error", this.onError);
    output.on("error", this.onError);
  }

  send(message) {
    if (this.closed) throw new Error("JSON-RPC transport closed");
    const encoded = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(encoded) > this.maxMessageBytes) throw new Error("JSON-RPC message too large");
    this.output.write(encoded);
  }

  request(method, params = {}, { timeoutMs = 60_000 } = {}) {
    if (this.closed) return Promise.reject(new Error("JSON-RPC transport closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("JSON-RPC request timed out: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.send({ jsonrpc: "2.0", method, params }); }

  receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    let end;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > this.maxMessageBytes) return this.close(new Error("JSON-RPC message too large"));
      const line = this.buffer.subarray(0, end).toString("utf8").trim();
      this.buffer = this.buffer.subarray(end + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") throw new Error();
      } catch { return this.close(new Error("Invalid JSON-RPC message")); }
      void this.dispatch(message);
    }
    if (this.buffer.length > this.maxMessageBytes) this.close(new Error("JSON-RPC message too large"));
  }

  async dispatch(message) {
    if (typeof message.method === "string") {
      const isRequest = Object.hasOwn(message, "id");
      try {
        if (!this.handler && isRequest) throw Object.assign(new Error("Method not found: " + message.method), { code: -32601 });
        const result = await this.handler?.(message.method, message.params ?? {});
        if (isRequest && !this.closed) this.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
      } catch (error) {
        if (isRequest && !this.closed) {
          try { this.send({ jsonrpc: "2.0", id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } }); }
          catch (sendError) { this.close(sendError); }
        }
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(Object.assign(new Error(message.error.message ?? "JSON-RPC error"), { code: message.error.code }));
    else if (Object.hasOwn(message, "result")) entry.resolve(message.result);
    else entry.reject(new Error("Invalid JSON-RPC response"));
  }

  close(error = new Error("JSON-RPC transport closed")) {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onEnd);
    // Keep error listeners: a closing owned child can still emit EPIPE.
    this.buffer = Buffer.alloc(0);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.resolveDone();
  }
}

export function spawnJsonLinePeer(command, args, { cwd, env, handler, maxMessageBytes } = {}) {
  if (!env || typeof env !== "object") throw new Error("Explicit child environment required");
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const peer = new JsonLinePeer(child.stdout, child.stdin, { handler, maxMessageBytes });
  let stderr = "", ended = false, resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const finish = error => { ended = true; peer.close(error); resolveExit(); };
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.once("error", finish);
  child.once("exit", (code, signal) => finish(new Error("Child closed: " + (signal ?? code) + (stderr ? "; " + stderr : ""))));
  async function wait(ms) {
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  }
  return {
    peer, process: child,
    async close() {
      peer.close();
      child.stdin.end();
      if (!ended) await wait(500);
      if (!ended) { child.kill("SIGTERM"); await wait(1000); }
      if (!ended) { child.kill("SIGKILL"); await exited; }
    },
  };
}
