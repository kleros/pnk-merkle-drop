#!/usr/bin/env node
/*
 * Serves the seeding page on this machine, for the browser wallet that signs the seeding on the hardware wallet:
 *
 *   node sign.js
 *
 * then opens, in the browser that has the wallet, the link cli.js or verify-snapshot.js printed for the week. The
 * page only answers on 127.0.0.1, loads nothing from the internet, and hands the wallet the transaction only after
 * checking it (see src/signer/seed.js). Stop it with Ctrl-C once the seedings are mined.
 */
import { SIGNER_PORT } from "./src/seeding.js";
import { createSignerServer } from "./src/signer/server.js";

const server = createSignerServer();
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${SIGNER_PORT} is taken. If it's another node sign.js, use that one; otherwise stop what holds the port.`
      : error.message
  );
  process.exit(1);
});
server.listen(SIGNER_PORT, "127.0.0.1", () => {
  console.log(`Serving the seeding page on http://127.0.0.1:${SIGNER_PORT}/ until Ctrl-C.`);
  console.log("Open the seeding link cli.js or verify-snapshot.js printed, in the browser that has the wallet.");
});
