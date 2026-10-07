import assert from "assert/strict";
import { readFileSync } from "fs";
import { describe, it } from "node:test";
import { BigNumber, Contract, constants } from "ethers";
import { CHAINS, KIP_86_LP_POOLS } from "../../src/config.js";
import { fetchJson } from "../../src/helpers/fetch-json.js";
import { IPFS_GATEWAY } from "../../src/helpers/published-snapshots.js";
import { assertClaimableOnChain, claimLeaf, verifyMerkleProof } from "../../src/invariants.js";
import { providers } from "./providers.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MERKLE_REDEEM_ABI = [
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function weekMerkleRoots(uint256) view returns (bytes32)",
  "function verifyClaim(address, uint256, uint256, bytes32[]) view returns (bool)",
];

describe("the contracts the run relies on", () => {
  it("has each chain's MerkleRedeem distribute the chain's token", async () => {
    for (const chain of CHAINS) {
      const merkleRedeem = new Contract(chain.merkleRedeem, MERKLE_REDEEM_ABI, providers[chain.chainId]);
      assert.equal((await merkleRedeem.token()).toLowerCase(), chain.token.toLowerCase(), `chain ${chain.chainId}`);
    }
  });

  it("has each chain's MerkleRedeem owned by the account the signing commands sign from", async () => {
    for (const chain of CHAINS) {
      const merkleRedeem = new Contract(chain.merkleRedeem, MERKLE_REDEEM_ABI, providers[chain.chainId]);
      assert.equal((await merkleRedeem.owner()).toLowerCase(), chain.owner.toLowerCase(), `chain ${chain.chainId}`);
    }
  });

  it("has each V4 position manager and state view work with the configured PoolManager", async () => {
    for (const lp of KIP_86_LP_POOLS.filter(({ type }) => type === "uniswap-v4")) {
      for (const peripheral of [lp.positionManager, lp.stateView]) {
        const contract = new Contract(
          peripheral,
          ["function poolManager() view returns (address)"],
          providers[lp.chainId]
        );
        assert.equal((await contract.poolManager()).toLowerCase(), lp.address.toLowerCase(), peripheral);
      }
    }
  });

  it("has Multicall3 wherever the run batches calls through it", async () => {
    for (const chainId of [1, 100, 42161]) {
      assert.notEqual(await providers[chainId].getCode(MULTICALL3), "0x", `chain ${chainId}`);
    }
  });
});

describe("the August 2026 drop against the deployed MerkleRedeem", () => {
  const golden = JSON.parse(readFileSync(new URL("../fixtures/golden-2026-08.json", import.meta.url), "utf8"));

  for (const { chainId, published } of golden.chains) {
    it(`agrees with how the run verifies claims, on chain ${chainId}`, async () => {
      const chain = CHAINS.find((c) => c.chainId === chainId);
      const provider = providers[chainId];
      const merkleRedeem = new Contract(chain.merkleRedeem, MERKLE_REDEEM_ABI, provider);
      const snapshot = await fetchJson(`${IPFS_GATEWAY}/${published.entry}`);
      assert.equal(await merkleRedeem.weekMerkleRoots(published.week), published.root);

      // every claim, as the run checks a new drop: through the storage override, a no-op on a seeded week
      const claims = Object.entries(snapshot.merkleTree.claims);
      assert.equal(
        await assertClaimableOnChain({
          provider,
          chainId,
          merkleRedeem: chain.merkleRedeem,
          week: published.week,
          snapshot,
        }),
        claims.length
      );
      // and on a week that is never seeded, where only the override puts the root in place, as it does for
      // every new week a run checks: an RPC that ignored the override would fail the run, blaming the claims
      const neverSeeded = 1000000;
      assert.equal(await merkleRedeem.weekMerkleRoots(neverSeeded), constants.HashZero);
      assert.equal(
        await assertClaimableOnChain({
          provider,
          chainId,
          merkleRedeem: chain.merkleRedeem,
          week: neverSeeded,
          snapshot,
        }),
        claims.length
      );

      // and the contract's verdict on tampered claims is the run's own
      for (const [address, claim] of claims.slice(0, 5)) {
        for (const value of [BigNumber.from(claim.value).add(1), BigNumber.from(claim.value).sub(1)]) {
          const contract = await merkleRedeem.verifyClaim(address, published.week, value, claim.proof);
          assert.equal(contract, false);
          assert.equal(verifyMerkleProof(claim.proof, published.root, claimLeaf(address, value)), contract);
        }
      }
    });
  }
});
