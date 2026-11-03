import { readFileSync } from "fs";
import { createServer } from "http";
import { CHAINS } from "../config.js";
import { signerChains } from "../seeding.js";

const JAVASCRIPT = "text/javascript; charset=utf-8";

// The page, its module, and the chains it checks links against, which come from config.js. They are read when
// the server starts, and the server serves these and nothing else.
const FILES = new Map([
  ["/", { type: "text/html; charset=utf-8", body: readFileSync(new URL("./index.html", import.meta.url)) }],
  ["/seed.js", { type: JAVASCRIPT, body: readFileSync(new URL("./seed.js", import.meta.url)) }],
  ["/chains.js", { type: JAVASCRIPT, body: `export const SEED_CHAINS = ${JSON.stringify(signerChains(CHAINS))};\n` }],
]);

/**
 * The server for the seeding page, to listen on 127.0.0.1. It answers only requests addressed to this machine by
 * name, so a site that points its own domain at 127.0.0.1 (DNS rebinding) gets nothing, and no other site may show
 * the page in a frame.
 */
export function createSignerServer() {
  const server = createServer((request, response) => {
    const { port } = server.address();
    // the path exactly as requested, up to the query string
    const file = FILES.get(request.url.split("?")[0]);
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host) ||
      request.method !== "GET" ||
      !file
    ) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        "Content-Type": file.type,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      })
      .end(file.body);
  });
  return server;
}
