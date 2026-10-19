/**
 * Unix-socket hub. Every shim (one per agy process) connects here and says
 * hello with its session key and its parent (agy) pid. tools/list and
 * tools/call requests are routed to the owning Session.
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

export class Hub {
  /** @param {(key: string) => any} resolveSession */
  constructor(resolveSession, socketPath = defaultSocketPath()) {
    this.resolveSession = resolveSession;
    this.socketPath = socketPath;
    this.server = null;
    this.conns = new Set();
  }

  async listen() {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(this.socketPath), 0o700);
    } catch {
      // ignore
    }
    rmSync(this.socketPath, { force: true });
    this.server = createServer((sock) => this.onConnection(sock));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
    try {
      chmodSync(this.socketPath, 0o600);
    } catch {
      // ignore
    }
  }

  close() {
    for (const c of this.conns) c.sock.destroy();
    this.conns.clear();
    this.server?.close();
    rmSync(this.socketPath, { force: true });
  }

  onConnection(sock) {
    sock.setEncoding("utf8");
    const conn = {
      sock,
      session: null,
      agyPid: 0,
      send: (msg) => {
        if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
      },
    };
    this.conns.add(conn);
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.onMessage(conn, line);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      this.conns.delete(conn);
      conn.session?.onShimDisconnected?.(conn);
    });
  }

  onMessage(conn, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const session = this.resolveSession(String(msg.session || ""));
      conn.gen = Number(msg.gen || 0);
      conn.agyPid = Number(msg.ppid || 0);
      conn.shimPid = Number(msg.pid || 0);
      if (!session) {
        log.warn("shim hello for unknown session", { session: msg.session });
        conn.sock.end();
        return;
      }
      conn.session = session;
      session.onShimConnected?.(conn);
      return;
    }
    const session = conn.session;
    if (!session) return;
    if (msg.type === "list") {
      conn.send({ type: "list_result", rid: msg.rid, tools: session.mcpTools ?? [] });
      session.onToolsListed?.(conn);
    } else if (msg.type === "call") {
      session.onToolCall(conn, msg);
    } else if (msg.type === "cancelled") {
      session.onToolCancelled?.(conn, msg);
    }
  }

  /** Ask a session's shim(s) to emit notifications/tools/list_changed. */
  notifyToolsChanged(session) {
    let n = 0;
    for (const c of this.conns) {
      if (c.session === session) {
        c.send({ type: "tools_changed" });
        n++;
      }
    }
    return n;
  }
}

export function defaultSocketPath() {
  // macOS caps unix socket paths at 104 bytes; keep this short.
  return process.env.OPENCODE_AGY_SOCKET_PATH || join(config.cacheDir, "run", `hub-${process.pid}.sock`);
}
