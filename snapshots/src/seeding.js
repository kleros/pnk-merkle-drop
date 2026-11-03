import { utils } from "ethers";

/*
 * The transaction that seeds a chain's drop, written out the way a hardware wallet shows it, so that a
 * signer can hold the device's screens against values computed from the verified files rather than
 * against a web page or the run that produced them. What each device shows was read from
 * LedgerHQ/app-ethereum (1.22), trezor/trezor-firmware (2.12) and, for the Trezor One, its legacy
 * firmware (1.14.1); see "Signing" in the README.
 */

export const SEED_ALLOCATIONS = "seedAllocations(uint256,bytes32,uint256)";
const seedInterface = new utils.Interface([`function ${SEED_ALLOCATIONS}`]);

// The port `node sign.js` serves the seeding page on, on 127.0.0.1 only.
export const SIGNER_PORT = 8765;

/** The link that opens the seeding page on a seeding transaction (see src/signer/seed.js). */
export const signerUrl = ({ chainId, merkleRedeem, data }) =>
  `http://127.0.0.1:${SIGNER_PORT}/?chainId=${chainId}&to=${merkleRedeem}&data=${data}`;

/**
 * The data the way a Trezor One shows it, from firmware 1.14.1 on: pages of up to 24 bytes, as three lines of
 * 8 bytes in uppercase hex, each page followed by how far into the data it reaches (layoutEthereumData in
 * trezor/trezor-firmware legacy/firmware/ethereum.c). It shows up to 5 pages, all of a seeding's 100 bytes;
 * firmware before 1.14.1 shows the first page only.
 */
export function trezorOnePages(data) {
  const hex = data.slice(2).toUpperCase();
  const length = hex.length / 2;
  const pages = [];
  for (let start = 0; start < length; start += 24) {
    const end = Math.min(start + 24, length);
    const lines = [];
    for (let line = start; line < end; line += 8) lines.push(hex.slice(line * 2, Math.min(line + 8, end) * 2));
    pages.push(`${lines.join(" ").padEnd(50)}   ${end < length ? "... " : ""}${end}/${length} bytes`);
  }
  return pages;
}

// The drop's chains: the network name Ledger's Ethereum app shows (src/network.c; it shows none for
// Ethereum itself), the token each chain's MerkleRedeem distributes, and where its transactions are listed.
const NETWORKS = {
  1: { name: "Ethereum", token: "PNK", explorer: "https://etherscan.io/tx/" },
  100: { name: "Gnosis", token: "stPNK", explorer: "https://gnosisscan.io/tx/" },
};

function networkOf(chainId) {
  const network = NETWORKS[chainId];
  if (!network) throw new Error(`No known network name for chain ${chainId} — add it to NETWORKS`);
  return network;
}

/**
 * The chains as the seeding page knows them, from CHAINS in config.js: `node sign.js` serves them to the page,
 * which refuses any link that doesn't seed one of them at its MerkleRedeem, from its owner.
 */
export const signerChains = (chains) =>
  Object.fromEntries(
    chains.map(({ chainId, merkleRedeem, owner, token }) => {
      const { name, token: symbol, explorer } = networkOf(chainId);
      return [
        chainId,
        {
          name,
          symbol,
          explorer,
          merkleRedeem: utils.getAddress(merkleRedeem),
          owner: utils.getAddress(owner),
          token: utils.getAddress(token),
        },
      ];
    })
  );

/**
 * A 32-byte word as Ledger's Ethereum app shows a "Parameter" with Debug contracts on: four 8-byte groups
 * in uppercase hex, joined by ":", each without its leading zero bytes, and "00" for a group of zeroes
 * (split_binary_parameter_part in LedgerHQ/app-ethereum src/features/sign_tx/logic_sign_tx.c).
 */
export const ledgerParameter = (word) =>
  [0, 8, 16, 24]
    .map(
      (start) =>
        utils
          .hexDataSlice(word, start, start + 8)
          .slice(2)
          .replace(/^(00)+/, "") || "00"
    )
    .join(":")
    .toUpperCase();

/** The seeding transaction's calldata, its three parameters and its ERC-8213 calldata digest. */
export function seedingTransaction({ week, root, amount }) {
  const data = seedInterface.encodeFunctionData("seedAllocations", [week, root, amount]);
  const parameters = [4, 36, 68].map((offset) => utils.hexDataSlice(data, offset, offset + 32));
  // ERC-8213: keccak256 of the calldata's length as a 32-byte big-endian number, then the calldata.
  const length = utils.defaultAbiCoder.encode(["uint256"], [utils.hexDataLength(data)]);
  return {
    data,
    selector: utils.hexDataSlice(data, 0, 4),
    parameters,
    digest: utils.keccak256(utils.concat([length, data])),
  };
}

/**
 * A seeding's link to the seeding page, on a line of its own so it can be copied whole, then what the hardware
 * wallet has to show for it: on a Trezor One, on the other Trezors and on a Ledger.
 *
 * @returns {string[]} The lines to print, under the seeding's step.
 */
export function seedingInstructions({ chainId, merkleRedeem, owner, week, root, amount }) {
  const network = networkOf(chainId);
  const { data, selector, parameters, digest } = seedingTransaction({ week, root, amount });
  // A Trezor Safe or Model T shows hex in lowercase without 0x.
  const bare = (hex) => hex.slice(2);
  return [
    signerUrl({ chainId, merkleRedeem, data }),
    `On the device, every one of these has to match a second person's verify-snapshot.js output:`,
    `  From        ${owner}   (the page sends from no other account; a Trezor doesn't show it)`,
    `  To          ${merkleRedeem}`,
    // A Trezor One's fee screens give the amounts in the network's coin, its definition's symbol, which a device that
    // has none for the chain (the wallet sends it) shows as UNKN (UNKNOWN_NETWORK in legacy/firmware).
    chainId === 1
      ? `  Network     the page only sends once the wallet is on chain 1; a Trezor One's fee screens say ETH`
      : `  Network     the page only sends once the wallet is on chain ${chainId}; a Trezor One's fee screens name ` +
        `${network.name}'s coin, or UNKN`,
    `  Amount      0 (a Trezor One shows "Send message to" the address; other devices may show no amount)`,
    `  Trezor One, "Transaction data:", in 5 pages:`,
    ...trezorOnePages(data).map((page) => `    ${page}`),
    `    A single page ending "... 100 bytes" is firmware before 1.14.1, which doesn't show the week, root or ` +
      `amount: reject, update it, sign again`,
    `  Trezor Safe or Model T, "View data and hash":`,
    `    Data              ${utils.hexDataLength(data)} bytes, ${bare(data)}`,
    `    ERC-8213 digest   ${bare(digest)}   (Safe 5 and Safe 7 only)`,
    chainId === 1
      ? `  With a Ledger instead (Blind signing and Debug contracts on; no Network row on Ethereum):`
      : `  With a Ledger instead (Blind signing and Debug contracts on; Network ${network.name}):`,
    `    Selector    ${bare(selector).toUpperCase()}   seedAllocations`,
    `    Parameter   ${ledgerParameter(parameters[0])}   week ${week}`,
    `    Parameter   ${ledgerParameter(parameters[1])}   merkle root`,
    `    Parameter   ${ledgerParameter(parameters[2])}   ${amount} wei`,
  ];
}

/**
 * The steps that make a period's drop claimable, in the order they have to happen: seed Ethereum, bridge
 * Gnosis's share and wrap it into stPNK, then seed Gnosis. Each seeding is a link to the page `node sign.js`
 * serves, followed by what the device has to show. A week already seeded with its root has nothing to sign,
 * and Gnosis's then needs no bridging either.
 *
 * @param {object[]} seedings The period's seedings, as chains of CHAINS with the week, root and amount each
 *   seeds, and its status: "seeded" when the week already has the root, "unseeded" otherwise.
 * @returns {string[]} The lines to print.
 */
export function executionSteps(seedings) {
  const [mainnet, gnosis] = [1, 100].map((chainId) => seedings.find((seeding) => seeding.chainId === chainId));
  if (seedings.some((seeding) => seeding !== mainnet && seeding !== gnosis)) {
    throw new Error("There are execution steps for Ethereum and Gnosis seedings only, one of each");
  }
  const step = (number, seeding) => {
    const { name, token } = networkOf(seeding.chainId);
    if (seeding.status === "seeded") {
      return [`  [${number}] Week ${seeding.week} on ${name} is already seeded with this exact root: nothing to sign.`];
    }
    return [
      `  [${number}] Seed week ${seeding.week} on ${name}, ${utils.formatEther(seeding.amount)} ${token}: ` +
        "open the link in the browser that has the wallet, then Check, then Send",
      ...seedingInstructions(seeding).map((line) => `      ${line}`),
    ];
  };

  const lines = ["Execution Steps:"];
  if (seedings.some(({ status }) => status !== "seeded")) {
    lines.push("  [Pre-req] node sign.js, in a second terminal from snapshots/: it serves the page the links open");
  }
  if (mainnet) {
    if (mainnet.status !== "seeded") lines.push("  [Pre-req] PNK should be already approved to Merkle Drop contract");
    lines.push(...step(1, mainnet));
  }
  if (gnosis) {
    if (gnosis.status !== "seeded") {
      lines.push(
        `  [2] https://bridge.gnosischain.com/ (amount: ${utils.formatEther(gnosis.amount)})`,
        "  [3] http://court.kleros.io and xPNK -> stPNK",
        "  [Pre-req] stPNK should be already approved to Merkle Drop contract"
      );
    }
    lines.push(...step(4, gnosis));
  }
  return lines;
}
