import { utils } from "ethers";

/*
 * The transaction that seeds a chain's drop, written out the way a hardware wallet shows it, so that a
 * signer can hold the device's screens against values computed from the verified files rather than
 * against a web page or the run that produced them. What each device shows was read from
 * LedgerHQ/app-ethereum (1.22) and trezor/trezor-firmware (2.12); see "Signing" in the README.
 */

export const SEED_ALLOCATIONS = "seedAllocations(uint256,bytes32,uint256)";
const seedInterface = new utils.Interface([`function ${SEED_ALLOCATIONS}`]);

// The drop's chains: the network name Ledger's Ethereum app shows (src/network.c; it shows none for
// Ethereum itself), and the token each chain's MerkleRedeem distributes.
const NETWORKS = { 1: { name: "Ethereum", token: "PNK" }, 100: { name: "Gnosis", token: "stPNK" } };

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
 * The commands that load the chain's RPC URL from .env, check the chain, simulate the transaction as the
 * owner and sign it locally with cast (Foundry) on the owner's Trezor, then what the device has to show,
 * and what a Ledger would show instead.
 *
 * @returns {string[]} The lines to print.
 */
export function seedingInstructions({ chainId, merkleRedeem, owner, rpcEnvVar, week, root, amount }) {
  const network = NETWORKS[chainId];
  if (!network) throw new Error(`No known network name for chain ${chainId} — add it to NETWORKS`);
  const { data, selector, parameters, digest } = seedingTransaction({ week, root, amount });
  const args = `"${SEED_ALLOCATIONS}" ${week} ${root} ${amount}`;
  const rpc = `--rpc-url "$${rpcEnvVar}"`;
  // Trezor shows hex in lowercase without 0x.
  const bare = (hex) => hex.slice(2);
  return [
    `  Seeding week ${week} on ${network.name}: ${utils.formatEther(amount)} ${network.token}`,
    `    1. Load the RPC URL:    export ${rpcEnvVar}="$(node -p 'require("dotenv").config().parsed.${rpcEnvVar}')"`,
    `    2. Check the chain:     cast chain-id ${rpc}   (must print ${chainId})`,
    `    3. Simulate:            cast call ${merkleRedeem} ${args} --from ${owner} ${rpc}   (must print 0x)`,
    `    4. Sign on the Trezor:  cast send ${merkleRedeem} ${args} --from ${owner} --trezor --chain ${chainId} ${rpc}`,
    `    On the device, every one of these has to match:`,
    `      From        ${owner}   (cast refuses any other account; a Trezor doesn't show it)`,
    `      To          ${merkleRedeem}`,
    `      Network     none shown on a Trezor: --chain ${chainId} and step 2 set it`,
    `      Amount      0 (the device may not show a zero amount)`,
    `      Trezor, "View data and hash":`,
    `        Data              ${utils.hexDataLength(data)} bytes, ${bare(data)}`,
    `        ERC-8213 digest   ${bare(digest)}   (Safe 5 and Safe 7 only)`,
    chainId === 1
      ? `      With a Ledger instead (--ledger; Blind signing and Debug contracts on; no Network row on Ethereum):`
      : `      With a Ledger instead (--ledger; Blind signing and Debug contracts on; Network ${network.name}):`,
    `        Selector    ${bare(selector).toUpperCase()}   seedAllocations`,
    `        Parameter   ${ledgerParameter(parameters[0])}   week ${week}`,
    `        Parameter   ${ledgerParameter(parameters[1])}   merkle root`,
    `        Parameter   ${ledgerParameter(parameters[2])}   ${amount} wei`,
  ];
}
