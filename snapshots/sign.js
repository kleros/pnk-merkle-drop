#!/usr/bin/env node
/*
 * Serves the seeding page on this machine, for the browser wallet that signs the seeding on the hardware wallet,
 * for the seedings of the snapshot files it is given, the ones the execution steps name:
 *
 *   node sign.js .cache/snapshot-2026-10.json .cache/xdai-snapshot-2026-10.json
 *
 * then opens, in the browser that has the wallet, the link cli.js or verify-snapshot.js printed for the week. The
 * page only answers on 127.0.0.1, loads nothing from the internet, refuses any link that doesn't seed the root and
 * amount of one of these files, and hands the wallet the transaction only after checking it (see
 * src/signer/seed.js). Stop it with Ctrl-C once the seedings are mined.
 */
import { utils } from "ethers";
import { CHAINS } from "./src/config.js";
import { SIGNER_PORT, signerChains } from "./src/seeding.js";
import { createSignerServer, snapshotSeedings } from "./src/signer/server.js";

const files = process.argv.slice(2);
let seedings;
try {
  if (!files.length) throw new Error("Usage: node sign.js <snapshot file>..., the files the execution steps name");
  seedings = snapshotSeedings(files);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const server = createSignerServer(seedings);
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${SIGNER_PORT} is taken. If it's another node sign.js, stop it and start this one; otherwise stop what holds the port.`
      : error.message
  );
  process.exit(1);
});
server.listen(SIGNER_PORT, "127.0.0.1", () => {
  console.log(`Serving the seeding page on http://127.0.0.1:${SIGNER_PORT}/ until Ctrl-C, for these seedings only:`);
  // as the page gets them
  for (const { name, symbol, seedings: allowed } of Object.values(signerChains(CHAINS, seedings))) {
    for (const { root, amount } of allowed) {
      console.log(`  ${name}: root ${root}, ${utils.formatEther(amount)} ${symbol}`);
    }
  }
  console.log("Open the seeding links cli.js or verify-snapshot.js printed, in the browser that has the wallet.");
});
