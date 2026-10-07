import assert from "assert/strict";
import { readFileSync } from "fs";
import { describe, it } from "node:test";
import { BigNumber, utils } from "ethers";
import * as config from "../src/config.js";
import { snapshotFilename } from "../src/helpers/published-snapshots.js";

const {
  CHAINS,
  KIP_86_ADDITIONAL_PNK_TOKENS,
  KIP_86_EXCLUDED_ADDRESSES,
  KIP_86_LP_POOLS,
  KIP_86_PNK_ADDRESSES,
  KIP_86_SABLIER,
  KIP_86_VESTING_ESCROWS,
} = config;

/*
 * The 14 addresses KIP-86 lists, as written in the proposal that passed on Snapshot:
 * https://forum.kleros.io/t/kip-86-exclude-pnk-held-by-the-kleros-cooperative-from-kip-66/1423
 *
 * Only a KIP can change which addresses are excluded. Changing KIP_86_EXCLUDED_ADDRESSES therefore
 * means changing this list too, citing the KIP that approves it. Copy addresses from the KIP itself:
 * the Cooperative's wallets receive look-alike address-poisoning transfers.
 */
const KIP_86_LISTED_ADDRESSES = [
  "0x86ead908fb5d6f900ff109c9e26f79300f99271a",
  "0xe979438b331b28d3246f8444b74cab0f874b40e8",
  "0xb2a33ae0e07fd2ca8dbde9545f6ce0b3234dc4e8",
  "0x5112d584a1c72fc250176b57aeba5ffbbb287d8f",
  "0xdc657fac185d00cdfa34a8378bb87d586bf998f7",
  "0xf636be494da13013f4506b1f5600089f2b4a1c6e",
  "0x67a57535b11445506a9e340662cd0c9755e5b1b4",
  "0x0ea9ddf020ce3bc13d508e7294fd8aca1cbae877",
  "0x879041adce0debb392c6334c1462b06e908057cd",
  "0xc80890ec72acb291bde13c448c54582e0bf3b688",
  "0x14560fdefdde97b36a5102a846f8b846c368f7d5",
  "0xc6b59d5e6c38de657f31d6254359f8739da2c07e",
  "0xf1468dbe2d6155aaf52f57879a1f3b307243e4a7",
  "0x718c76d04992a9f026260e8436cc565a9c1b6a8a",
];

const deployment = (network) =>
  JSON.parse(readFileSync(new URL(`../../contracts/deployments/${network}/MerkleRedeem.json`, import.meta.url)));

// Every string in the config that is meant to be an address.
function addressesIn(value, path = "config") {
  if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/.test(value) || /^0x/.test(value) ? [[path, value]] : [];
  if (BigNumber.isBigNumber(value)) return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => addressesIn(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => addressesIn(item, `${path}.${key}`));
  }
  return [];
}

describe("config", () => {
  it("excludes exactly the addresses KIP-86 lists", () => {
    const configured = KIP_86_EXCLUDED_ADDRESSES.map((address) => address.toLowerCase());
    assert.equal(new Set(configured).size, configured.length, "an address is listed twice");
    assert.deepEqual([...configured].sort(), [...KIP_86_LISTED_ADDRESSES].sort());
  });

  it("has only valid addresses, with a valid checksum where they are mixed-case", () => {
    const found = addressesIn(config);
    assert.ok(found.length > 30);
    for (const [path, address] of found) {
      // getAddress rejects a mixed-case address whose checksum doesn't match, i.e. one with a typo
      assert.doesNotThrow(() => utils.getAddress(address), `${path} is not a valid address: ${address}`);
    }
  });

  it("splits the whole reward between the chains", () => {
    const total = CHAINS.reduce((sum, { pnkDropRatio }) => sum.add(pnkDropRatio), BigNumber.from(0));
    assert.equal(total.toString(), "1000000000");
    for (const { chainId, pnkDropRatio } of CHAINS) assert.ok(pnkDropRatio.gt(0), `chain ${chainId} gets nothing`);
  });

  it("seeds each chain's drop into the MerkleRedeem deployed for it, which distributes the chain's token", () => {
    for (const [chainId, network] of [
      [1, "mainnet"],
      [100, "xdai"],
    ]) {
      const chain = CHAINS.find((c) => c.chainId === chainId);
      const { address, args } = deployment(network);
      assert.equal(utils.getAddress(chain.merkleRedeem), utils.getAddress(address));
      assert.equal(utils.getAddress(chain.token), utils.getAddress(args[0]));
    }
  });

  it("reads the supply from the PNK mainnet drops, and excludes the stPNK Gnosis drops", () => {
    const [mainnet, gnosis] = CHAINS;
    assert.equal(mainnet.token.toLowerCase(), KIP_86_PNK_ADDRESSES[1].toLowerCase());
    assert.ok(KIP_86_ADDITIONAL_PNK_TOKENS[100].some((token) => token.toLowerCase() === gnosis.token.toLowerCase()));
  });

  it("knows the PNK address of every chain it looks for KIP-86 positions on", () => {
    const chainIds = [
      ...KIP_86_LP_POOLS.map(({ chainId }) => chainId),
      ...Object.keys(KIP_86_SABLIER),
      ...Object.keys(KIP_86_VESTING_ESCROWS),
    ];
    for (const chainId of chainIds) assert.ok(KIP_86_PNK_ADDRESSES[chainId], `chain ${chainId} has no PNK address`);
  });

  it("describes every LP pool completely", () => {
    for (const pool of KIP_86_LP_POOLS) {
      assert.ok(["uniswap-v4", "v2-pair"].includes(pool.type), `unknown pool type ${pool.type}`);
      if (pool.type === "uniswap-v4") assert.ok(pool.positionManager && pool.stateView && pool.address);
    }
  });

  it("lists each exclusion source once, since one listed twice would be excluded twice", () => {
    const sources = [
      ...KIP_86_LP_POOLS.map(({ chainId, address }) => `LP ${chainId}:${address}`),
      ...Object.entries(KIP_86_SABLIER).flatMap(([chainId, { contracts }]) =>
        contracts.map((contract) => `Sablier ${chainId}:${contract}`)
      ),
    ].map((source) => source.toLowerCase());
    assert.deepEqual(
      sources.filter((source, i) => sources.indexOf(source) !== i),
      [],
      "listed more than once"
    );
  });

  it("names snapshots the way the Court frontend and the last-drop lookup expect", () => {
    assert.equal(snapshotFilename(1, "2026-09"), "snapshot-2026-09.json");
    assert.equal(snapshotFilename(100, "2026-09"), "xdai-snapshot-2026-09.json");
    assert.throws(() => snapshotFilename(42161, "2026-09"), /No known snapshot filename convention/);
  });
});
