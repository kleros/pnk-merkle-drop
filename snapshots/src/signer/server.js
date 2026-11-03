import { BigNumber } from "ethers";
import { readFileSync } from "fs";
import { createServer } from "http";
import { basename } from "path";
import { CHAINS } from "../config.js";
import { snapshotFilename } from "../helpers/published-snapshots.js";
import { signerChains } from "../seeding.js";

const JAVASCRIPT = "text/javascript; charset=utf-8";

// The page and its module, read when the module is loaded.
const PAGE = readFileSync(new URL("./index.html", import.meta.url));
const MODULE = readFileSync(new URL("./seed.js", import.meta.url));

/**
 * The seedings of snapshot files, the only ones the page will then hand the wallet: each file's chain, by its name
 * as cli.js writes it (verify-snapshot.js reads it the same way), and the merkle root and amount it seeds. One file
 * per chain.
 *
 * @param {string[]} files The snapshot files' paths.
 * @returns {{ chainId: number, root: string, amount: BigNumber }[]}
 */
export function snapshotSeedings(files) {
  const seedings = [];
  for (const file of files) {
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    if (typeof snapshot?.startDate !== "string") throw new Error(`${file} isn't a snapshot: it has no startDate`);
    const period = snapshot.startDate.slice(0, 7);
    const chain = CHAINS.find(({ chainId }) => snapshotFilename(chainId, period) === basename(file));
    if (!chain) throw new Error(`${file} isn't named like a ${period} snapshot of any chain the drop is on`);
    if (seedings.some(({ chainId }) => chainId === chain.chainId)) {
      throw new Error(`${file} is a second snapshot of chain ${chain.chainId}: give one file per chain`);
    }
    const root = snapshot.merkleTree?.root;
    if (!/^0x[0-9a-fA-F]{64}$/.test(root)) throw new Error(`${file} has no 32-byte merkle root`);
    seedings.push({ chainId: chain.chainId, root, amount: BigNumber.from(snapshot.droppedAmount) });
  }
  return seedings;
}

/**
 * The server for the seeding page, to listen on 127.0.0.1. It serves the page, its module, and the chains it
 * checks links against, from config.js with the seedings given, and nothing else. It answers only requests
 * addressed to this machine by name, so a site that points its own domain at 127.0.0.1 (DNS rebinding) gets
 * nothing, and no other site may show the page in a frame.
 *
 * @param {object[]} seedings What snapshotSeedings read from the files `node sign.js` was started with.
 */
export function createSignerServer(seedings) {
  const files = new Map([
    ["/", { type: "text/html; charset=utf-8", body: PAGE }],
    ["/seed.js", { type: JAVASCRIPT, body: MODULE }],
    [
      "/chains.js",
      { type: JAVASCRIPT, body: `export const SEED_CHAINS = ${JSON.stringify(signerChains(CHAINS, seedings))};\n` },
    ],
  ]);
  const server = createServer((request, response) => {
    const { port } = server.address();
    // the path exactly as requested, up to the query string
    const file = files.get(request.url.split("?")[0]);
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
