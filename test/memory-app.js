/** In-memory req/res exchange. No listener, fetch, socket or child process. */
import { EventEmitter } from "node:events";
import { createApp } from "../src/server.js";
import { Pool } from "../src/pool.js";
import { Session } from "../src/session.js";
import { MemStore, stubWorkspace } from "./helpers.js";

export async function startMemoryApp(processFactory) {
  const store = new MemStore();
  const workspace = stubWorkspace();
  const pool = new Pool({ store, sessionFactory: (o) => new Session({ ...o, processFactory, workspace }) });
  const app = createApp({ pool, store });
  return {
    base: "http://synthetic.invalid",
    pool,
    store,
    async request(url, options) {
      const req = new EventEmitter();
      Object.assign(req, { url: new URL(url).pathname, method: options.method, headers: options.headers });
      const res = new EventEmitter();
      const chunks = [];
      let headers = {};
      let status = 200;
      Object.assign(res, {
        destroyed: false, writableEnded: false, headersSent: false,
        writeHead(code, value) { status = code; headers = value; this.headersSent = true; },
        flushHeaders() {},
        write(value) { chunks.push(value); return true; },
        end(value) { if (value) chunks.push(value); this.writableEnded = true; },
      });
      req.destroy = () => { throw new Error("Unexpected request destruction"); };
      const handling = app.handle(req, res);
      req.emit("data", Buffer.from(options.body));
      req.emit("end");
      await handling;
      if (!res.writableEnded) throw new Error("Response did not end");
      return new Response(chunks.join(""), { status, headers });
    },
    async close() { await pool.shutdown(); },
  };
}
