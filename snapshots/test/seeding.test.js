import assert from "assert/strict";
import { describe, it } from "node:test";
import { CHAINS } from "../src/config.js";
import { ledgerParameter, seedingInstructions, seedingTransaction } from "../src/seeding.js";

// Ethereum's September 2026 drop, from the published snapshot-2026-09.json, seeded as week 67 in
// 0x2a753bce2f6fe061f69767d1f55880888bcee4bbbe58ce5c025d9aa8e4d5434f.
const september = {
  week: 67,
  root: "0x091d2f0acb2fc4bb9e4d7aa50b5072ecf64de9f83cb2195dcd0beb84be22bed0",
  amount: "3119959493871731907175751",
};

describe("seeding transaction", () => {
  it("is the calldata the September 2026 drop was seeded with", () => {
    assert.equal(
      seedingTransaction(september).data,
      "0x4cd488ab0000000000000000000000000000000000000000000000000000000000000043091d2f0acb2fc4bb9e4d7aa50b5072ecf64de9f83cb2195dcd0beb84be22bed00000000000000000000000000000000000000000000294ad57d32e7ca7eb2547"
    );
  });

  it("shows the parameters the way Ledger's Ethereum app does", () => {
    assert.deepEqual(seedingTransaction(september).parameters.map(ledgerParameter), [
      "00:00:00:43",
      "091D2F0ACB2FC4BB:9E4D7AA50B5072EC:F64DE9F83CB2195D:CD0BEB84BE22BED0",
      "00:00:0294AD:57D32E7CA7EB2547",
    ]);
    // a group's leading zero bytes are dropped, so a group can be shorter than 16 characters
    assert.equal(
      ledgerParameter(`0x00ab${"11".repeat(30)}`),
      "AB111111111111:1111111111111111:1111111111111111:1111111111111111"
    );
  });

  // keccak256(uint256(100) ‖ calldata), the same as `cast keccak $(cast concat-hex $(cast to-uint256 100) <calldata>)`
  it("has the ERC-8213 calldata digest a Trezor shows", () => {
    assert.equal(
      seedingTransaction(september).digest,
      "0xd4de4b7eeccc720e4f9e83b947906d298ec94863120454f6875eccdfce6b671f"
    );
  });

  it("prints the commands and the device's screens for the September 2026 seeding, line for line", () => {
    const [mainnet] = CHAINS;
    const call = `"seedAllocations(uint256,bytes32,uint256)" 67 ${september.root} ${september.amount}`;
    const from = "--from 0x28A81EC3045F079DCf051BA2F3280335D18144cC";
    const rpc = '--rpc-url "$ALCHEMY_ETH_MAINNET_RPC"';
    assert.deepEqual(seedingInstructions({ ...mainnet, ...september }), [
      "  Seeding week 67 on Ethereum: 3119959.493871731907175751 PNK",
      `    1. Load the RPC URL:  export ALCHEMY_ETH_MAINNET_RPC="$(node -p 'require("dotenv").config().parsed.ALCHEMY_ETH_MAINNET_RPC')"`,
      `    2. Check the chain:   cast chain-id ${rpc}   (must print 1)`,
      `    3. Simulate:          cast call 0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38 ${call} ${from} ${rpc}   (must print 0x)`,
      `    4. Sign on a Ledger:  cast send 0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38 ${call} ${from} --ledger --chain 1 ${rpc}`,
      "    On the device, every one of these has to match:",
      "      From        0x28A81EC3045F079DCf051BA2F3280335D18144cC   (a Ledger shows it; cast refuses any other account)",
      "      To          0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38",
      "      Network     none shown (a Ledger names only networks other than Ethereum)",
      "      Amount      0 (the device may not show a zero amount)",
      "      Ledger, with Blind signing and Debug contracts on:",
      "        Selector    4CD488AB   seedAllocations",
      "        Parameter   00:00:00:43   week 67",
      "        Parameter   091D2F0ACB2FC4BB:9E4D7AA50B5072EC:F64DE9F83CB2195D:CD0BEB84BE22BED0   merkle root",
      "        Parameter   00:00:0294AD:57D32E7CA7EB2547   3119959493871731907175751 wei",
      '      Trezor, "View data and hash":',
      "        Data              100 bytes, 4cd488ab0000000000000000000000000000000000000000000000000000000000000043091d2f0acb2fc4bb9e4d7aa50b5072ecf64de9f83cb2195dcd0beb84be22bed00000000000000000000000000000000000000000000294ad57d32e7ca7eb2547",
      "        ERC-8213 digest   d4de4b7eeccc720e4f9e83b947906d298ec94863120454f6875eccdfce6b671f   (Safe 5 and Safe 7 only)",
    ]);
  });

  it("signs on Gnosis with Gnosis's chain ID, and knows no other chain", () => {
    const [mainnet, gnosis] = CHAINS;
    const lines = seedingInstructions({ ...gnosis, ...september });
    assert.equal(lines[0], "  Seeding week 67 on Gnosis: 3119959.493871731907175751 stPNK");
    assert.ok(lines.includes("      Network     Gnosis (on a Ledger; a Trezor shows no network)"));
    assert.ok(lines.find((line) => line.includes("cast send")).includes(" --ledger --chain 100 "));
    assert.ok(lines.find((line) => line.includes("cast chain-id")).endsWith("(must print 100)"));
    assert.throws(() => seedingInstructions({ ...mainnet, chainId: 42161, ...september }), /No known network name/);
  });
});
