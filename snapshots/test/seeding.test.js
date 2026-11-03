import assert from "assert/strict";
import { describe, it } from "node:test";
import { CHAINS } from "../src/config.js";
import { BigNumber } from "ethers";
import {
  executionSteps,
  ledgerParameter,
  seedingInstructions,
  seedingTransaction,
  trezorOnePages,
} from "../src/seeding.js";

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

  it("prints the link and the device's screens for the September 2026 seeding, line for line", () => {
    const [mainnet] = CHAINS;
    const data = seedingTransaction(september).data;
    assert.deepEqual(seedingInstructions({ ...mainnet, ...september }), [
      `http://127.0.0.1:8765/?chainId=1&to=0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38&data=${data}`,
      "On the device, every one of these has to match a second person's verify-snapshot.js output:",
      "  From        0x28A81EC3045F079DCf051BA2F3280335D18144cC   (the page sends from no other account; a Trezor doesn't show it)",
      "  To          0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38",
      "  Network     the page only sends once the wallet is on chain 1; a Trezor One's fee screens say ETH",
      '  Amount      0 (a Trezor One shows "Send message to" the address; other devices may show no amount)',
      '  Trezor One, "Transaction data:", in 5 pages:',
      "    4CD488AB00000000 0000000000000000 0000000000000000   ... 24/100 bytes",
      "    0000000000000000 00000043091D2F0A CB2FC4BB9E4D7AA5   ... 48/100 bytes",
      "    0B5072ECF64DE9F8 3CB2195DCD0BEB84 BE22BED000000000   ... 72/100 bytes",
      "    0000000000000000 0000000000000000 000294AD57D32E7C   ... 96/100 bytes",
      "    A7EB2547                                             100/100 bytes",
      '    A single page ending "... 100 bytes" is firmware before 1.14.1, which doesn\'t show the week, root or amount: reject, update it, sign again',
      '  Trezor Safe or Model T, "View data and hash":',
      "    Data              100 bytes, 4cd488ab0000000000000000000000000000000000000000000000000000000000000043091d2f0acb2fc4bb9e4d7aa50b5072ecf64de9f83cb2195dcd0beb84be22bed00000000000000000000000000000000000000000000294ad57d32e7ca7eb2547",
      "    ERC-8213 digest   d4de4b7eeccc720e4f9e83b947906d298ec94863120454f6875eccdfce6b671f   (Safe 5 and Safe 7 only)",
      "  With a Ledger instead (Blind signing and Debug contracts on; no Network row on Ethereum):",
      "    Selector    4CD488AB   seedAllocations",
      "    Parameter   00:00:00:43   week 67",
      "    Parameter   091D2F0ACB2FC4BB:9E4D7AA50B5072EC:F64DE9F83CB2195D:CD0BEB84BE22BED0   merkle root",
      "    Parameter   00:00:0294AD:57D32E7CA7EB2547   3119959493871731907175751 wei",
    ]);
  });

  it("seeds Gnosis on Gnosis's chain ID, and knows no other chain", () => {
    const [mainnet, gnosis] = CHAINS;
    const lines = seedingInstructions({ ...gnosis, ...september });
    assert.equal(
      lines[0],
      `http://127.0.0.1:8765/?chainId=100&to=0xf1A9589880DbF393F32A5b2d5a0054Fa10385074&data=${
        seedingTransaction(september).data
      }`
    );
    assert.ok(
      lines.includes(
        "  Network     the page only sends once the wallet is on chain 100; a Trezor One's fee screens name Gnosis's coin, or UNKN"
      )
    );
    assert.ok(lines.includes("  With a Ledger instead (Blind signing and Debug contracts on; Network Gnosis):"));
    assert.throws(() => seedingInstructions({ ...mainnet, chainId: 42161, ...september }), /No known network name/);
  });

  it("pages the data the way a Trezor One does, whatever the length", () => {
    // 100 bytes take five pages of 24; a page short of three lines leaves them out
    assert.equal(trezorOnePages(seedingTransaction(september).data).length, 5);
    assert.deepEqual(trezorOnePages(`0x${"ab".repeat(8)}${"cd".repeat(3)}`), [
      `${"AB".repeat(8)} ${"CD".repeat(3)}`.padEnd(50) + "   11/11 bytes",
    ]);
    assert.deepEqual(trezorOnePages(`0x${"01".repeat(24)}`), [
      `${"01".repeat(8)} ${"01".repeat(8)} ${"01".repeat(8)}   24/24 bytes`,
    ]);
  });
});

describe("execution steps", () => {
  const [mainnet, gnosis] = CHAINS;
  // The October 2026 seedings, as cli.js printed them on 2026-11-01.
  const ethereum = {
    ...mainnet,
    week: 68,
    root: "0x3c4e12574473f45ba03a02bf4987d02427e6703f1c38bb54dd41f0108ca5f3bf",
    amount: BigNumber.from("2921589957683974625773330"),
    status: "unseeded",
    file: ".cache/snapshot-2026-10.json",
  };
  const xdai = {
    ...gnosis,
    week: 63,
    root: "0xdbdf13a7bee2200de04a0f2100f0022db7c04cfb4e7f96e33c575014dbcdc5d4",
    amount: BigNumber.from("324621106409330513974814"),
    status: "unseeded",
    file: ".cache/xdai-snapshot-2026-10.json",
  };
  const seeded = (seeding) => ({ ...seeding, status: "seeded" });
  const steps = (lines) => lines.filter((line) => line.startsWith("  ["));
  const serve =
    "  [Pre-req] In a second terminal, from snapshots/, serve the page the links open, for these files only:";
  // the command that serves it, on the line after
  const command = (lines) => lines[lines.indexOf(serve) + 1];
  const approvePnk = "  [Pre-req] PNK should be already approved to Merkle Drop contract";
  const seedEthereum =
    "  [1] Seed week 68 on Ethereum, 2921589.95768397462577333 PNK: open the link in the browser that has the wallet, then Check, then Send";
  const bridge = "  [2] https://bridge.gnosischain.com/ (amount: 324621.106409330513974814)";
  const wrap = "  [3] https://court.kleros.io and xPNK -> stPNK";
  const approveStPnk = "  [Pre-req] stPNK should be already approved to Merkle Drop contract";
  const seedGnosis =
    "  [4] Seed week 63 on Gnosis, 324621.106409330513974814 stPNK: open the link in the browser that has the wallet, then Check, then Send";

  it("seeds Ethereum, bridges Gnosis's share and wraps it, then seeds Gnosis, in that order", () => {
    const lines = executionSteps([ethereum, xdai]);
    assert.equal(lines[0], "Execution Steps:");
    assert.deepEqual(steps(lines), [serve, approvePnk, seedEthereum, bridge, wrap, approveStPnk, seedGnosis]);
    assert.equal(command(lines), "      node sign.js .cache/snapshot-2026-10.json .cache/xdai-snapshot-2026-10.json");
    // under each seeding, its link and what the device shows
    const indented = (seeding) => seedingInstructions(seeding).map((line) => `      ${line}`);
    assert.deepEqual(lines.slice(lines.indexOf(seedEthereum) + 1, lines.indexOf(bridge)), indented(ethereum));
    assert.deepEqual(lines.slice(lines.indexOf(seedGnosis) + 1), indented(xdai));
    assert.equal(
      lines[lines.indexOf(seedEthereum) + 1],
      "      http://127.0.0.1:8765/?chainId=1&to=0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38&data=0x4cd488ab00000000000000000000000000000000000000000000000000000000000000443c4e12574473f45ba03a02bf4987d02427e6703f1c38bb54dd41f0108ca5f3bf000000000000000000000000000000000000000000026aabb57e82918b5b4712"
    );
    assert.equal(
      lines[lines.indexOf(seedGnosis) + 1],
      "      http://127.0.0.1:8765/?chainId=100&to=0xf1A9589880DbF393F32A5b2d5a0054Fa10385074&data=0x4cd488ab000000000000000000000000000000000000000000000000000000000000003fdbdf13a7bee2200de04a0f2100f0022db7c04cfb4e7f96e33c575014dbcdc5d40000000000000000000000000000000000000000000044bdbed52af3ba26961e"
    );
  });

  it("leaves out what is done already", () => {
    // sign.js only needs the files of the weeks left to seed
    assert.equal(
      command(executionSteps([seeded(ethereum), xdai])),
      "      node sign.js .cache/xdai-snapshot-2026-10.json"
    );
    assert.equal(command(executionSteps([ethereum, seeded(xdai)])), "      node sign.js .cache/snapshot-2026-10.json");
    assert.deepEqual(steps(executionSteps([seeded(ethereum), xdai])), [
      serve,
      "  [1] Week 68 on Ethereum is already seeded with this exact root: nothing to sign.",
      bridge,
      wrap,
      approveStPnk,
      seedGnosis,
    ]);
    // a seeded Gnosis week needs no bridging either
    assert.deepEqual(steps(executionSteps([ethereum, seeded(xdai)])), [
      serve,
      approvePnk,
      seedEthereum,
      "  [4] Week 63 on Gnosis is already seeded with this exact root: nothing to sign.",
    ]);
    assert.deepEqual(executionSteps([seeded(ethereum), seeded(xdai)]), [
      "Execution Steps:",
      "  [1] Week 68 on Ethereum is already seeded with this exact root: nothing to sign.",
      "  [4] Week 63 on Gnosis is already seeded with this exact root: nothing to sign.",
    ]);
    // verify-snapshot.js given one chain's file
    assert.deepEqual(steps(executionSteps([xdai])), [serve, bridge, wrap, approveStPnk, seedGnosis]);
  });

  it("has steps for one Ethereum and one Gnosis seeding only, each from its snapshot file", () => {
    assert.throws(() => executionSteps([ethereum, { ...ethereum }]), /Ethereum and Gnosis seedings only/);
    assert.throws(() => executionSteps([{ ...ethereum, chainId: 42161 }]), /Ethereum and Gnosis seedings only/);
    assert.throws(
      () => executionSteps([ethereum, { ...xdai, file: undefined }]),
      /Gnosis seeding has no snapshot file/
    );
    // a seeded week needs none
    assert.doesNotThrow(() => executionSteps([ethereum, seeded({ ...xdai, file: undefined })]));
  });
});
