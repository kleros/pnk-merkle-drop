import assert from "assert/strict";
import { describe, it } from "node:test";
import { Contract } from "ethers";
import {
  KIP_86_ADDITIONAL_PNK_TOKENS,
  KIP_86_EXCLUDED_ADDRESSES,
  KIP_86_LP_POOLS,
  KIP_86_PNK_ADDRESSES,
  KIP_86_SABLIER,
  KIP_86_VESTING_ESCROWS,
  V3_POSITION_MANAGER,
} from "../../src/config.js";
import { createBlockFetchers } from "../../src/helpers/blocks.js";
import { getCoopV2PairPnk } from "../../src/helpers/amm-v2-pair-positions.js";
import { getCoopSablierPnk } from "../../src/helpers/sablier-streams.js";
import { getCoopV3Pnk } from "../../src/helpers/uniswap-v3-positions.js";
import { getCoopV4Pnk } from "../../src/helpers/uniswap-v4-positions.js";
import { getCoopVestingEscrowPnk } from "../../src/helpers/vesting-escrows.js";
import { getCoopWalletBalances } from "../../src/helpers/wallet-balances.js";
import { assertPinnedBlock } from "../../src/invariants.js";
import { providers } from "./providers.js";

/*
 * The September 2026 exclusions, read at the period's pinned blocks: chain state at a past block never
 * changes, so every helper has to keep giving exactly these amounts. They are the ones the September run
 * published (its adjustedSupply) and were cross-checked independently (Sablier's indexer, DeBank, a
 * second RPC) when the run was audited.
 */
const END = new Date("2026-10-01T00:00:00.000Z");
const BLOCKS = { 1: 26093737, 100: 48524423, 42161: 510496863 };
const EXPECTED = {
  wallets: { 1: "47337058469863315235120399", 100: "87624021755041082884550", 42161: "2071567891554876204021261" },
  "uniswap-v4": { 1: "85098359873357370516483065", 42161: "0" },
  "v2-pair": { 100: "8426907924572594156173421", 42161: "6294464541903764521075241" },
  "uniswap-v3": { 1: "0", 42161: "0" },
  sablier: { 1: "7521431860211784972386888", 42161: "2443555614373184064532222" },
  llamapay: { 1: "0", 42161: "1668186171340989182266101" },
  totalSupply: "915528222079312772774086827",
  adjustedSupply: "754579065710379852839143679",
};
const TOTAL_EXCLUDED = "160949156368932919934943148";

const common = (chainId) => ({
  provider: providers[chainId],
  pnkAddress: KIP_86_PNK_ADDRESSES[chainId],
  excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
  blockTag: BLOCKS[chainId],
});

describe("KIP-86 exclusions at the September 2026 blocks", { concurrency: true }, () => {
  it("pins each chain to its last block of September 2026", async () => {
    for (const [chainId, blockTag] of Object.entries(BLOCKS)) {
      assert.equal(await createBlockFetchers(providers[chainId]).findLastBefore(END), blockTag, `chain ${chainId}`);
      await assertPinnedBlock({ provider: providers[chainId], chainId, blockTag, date: END });
    }
  });

  it("reads the Cooperative's wallets", async () => {
    const balances = await getCoopWalletBalances({
      providers,
      pnkAddresses: KIP_86_PNK_ADDRESSES,
      additionalPnkTokens: KIP_86_ADDITIONAL_PNK_TOKENS,
      excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
      blockTags: BLOCKS,
    });
    for (const [chainId, expected] of Object.entries(EXPECTED.wallets)) {
      const sum = balances
        .filter((balance) => balance.chainId === Number(chainId))
        .reduce((total, { balance }) => total + BigInt(balance.toString()), 0n);
      assert.equal(String(sum), expected, `chain ${chainId}`);
    }
  });

  // Each check below also runs over the sources the expected amounts were read from, not just over the
  // config: a source dropped from the config has to fail here, not just stop being checked.
  it("reads the LP pools", async () => {
    for (const type of ["uniswap-v4", "v2-pair"]) {
      for (const chainId of Object.keys(EXPECTED[type])) {
        const configured = KIP_86_LP_POOLS.some((lp) => lp.type === type && lp.chainId === Number(chainId));
        assert.ok(configured, `KIP_86_LP_POOLS has no ${type} pool on chain ${chainId}`);
      }
    }
    for (const lp of KIP_86_LP_POOLS) {
      const { balance } =
        lp.type === "uniswap-v4"
          ? await getCoopV4Pnk({
              ...common(lp.chainId),
              positionManager: lp.positionManager,
              stateView: lp.stateView,
              poolManager: lp.address,
            })
          : await getCoopV2PairPnk({ ...common(lp.chainId), pairAddress: lp.address });
      assert.equal(String(balance), EXPECTED[lp.type][lp.chainId], `${lp.name} on chain ${lp.chainId}`);
    }
    for (const chainId of [1, 42161]) {
      const { balance } = await getCoopV3Pnk({ ...common(chainId), positionManager: V3_POSITION_MANAGER });
      assert.equal(String(balance), EXPECTED["uniswap-v3"][chainId], `Uniswap V3 on chain ${chainId}`);
    }
  });

  it("reads the Sablier streams", async () => {
    for (const chainId of Object.keys(EXPECTED.sablier)) {
      const { contracts = [] } = KIP_86_SABLIER[chainId] ?? {};
      const { balance } = await getCoopSablierPnk({ ...common(chainId), sablierContracts: contracts });
      assert.equal(String(balance), EXPECTED.sablier[chainId], `chain ${chainId}`);
    }
  });

  it("reads the LlamaPay escrows", async () => {
    for (const chainId of Object.keys(EXPECTED.llamapay)) {
      assert.ok(KIP_86_VESTING_ESCROWS[chainId], `KIP_86_VESTING_ESCROWS has no factory on chain ${chainId}`);
      const { factory, fromBlock } = KIP_86_VESTING_ESCROWS[chainId];
      const { balance } = await getCoopVestingEscrowPnk({ ...common(chainId), factory, fromBlock });
      assert.equal(String(balance), EXPECTED.llamapay[chainId], `chain ${chainId}`);
    }
  });

  it("adds up to the adjusted supply the September 2026 snapshots published", async () => {
    const pnk = new Contract(KIP_86_PNK_ADDRESSES[1], ["function totalSupply() view returns (uint256)"], providers[1]);
    const totalSupply = BigInt((await pnk.totalSupply({ blockTag: BLOCKS[1] })).toString());
    assert.equal(totalSupply.toString(), EXPECTED.totalSupply);
    assert.equal(totalSupply - BigInt(TOTAL_EXCLUDED), BigInt(EXPECTED.adjustedSupply));
    const counted = Object.entries(EXPECTED)
      .filter(([, value]) => typeof value === "object")
      .flatMap(([, perChain]) => Object.values(perChain))
      .reduce((total, value) => total + BigInt(value), 0n);
    assert.equal(counted.toString(), TOTAL_EXCLUDED);
  });
});
