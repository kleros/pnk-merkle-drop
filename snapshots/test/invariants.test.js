import assert from "assert/strict";
import { describe, it } from "node:test";
import { BigNumber, constants, utils } from "ethers";
import { CHAINS, KIP_86_EXCLUDED_ADDRESSES } from "../src/config.js";
import {
  InvariantError,
  assertClaimableOnChain,
  assertDropSplit,
  assertPinnedBlock,
  assertReward,
  assertSeedingWeek,
  assertSnapshotIntegrity,
  claimLeaf,
  scheduledTarget,
  verifyMerkleProof,
} from "../src/invariants.js";
import { FakeChain, Revert } from "./support/fake-chain.js";
import { buildSnapshot } from "./support/snapshot.js";

const wei = (value) => BigNumber.from(value);
// a BigNumber as it reads in an uploaded snapshot
const json = (value) => JSON.parse(JSON.stringify(wei(value)));

const violates = (pattern) => (error) => error instanceof InvariantError && pattern.test(error.message);

const startDate = new Date("2026-09-01T00:00:00.000Z");
const endDate = new Date("2026-10-01T00:00:00.000Z");
const endBlock = 26093737;
const adjustedSupply = wei("754579065710379852839143679");
const droppedAmount = wei("3119959493871731907175751");
const jurors = Array.from({ length: 9 }, (_, i) =>
  utils.getAddress(utils.hexZeroPad(utils.hexlify(0x1000 + i * 7919), 20))
);
const stakesOf = (addresses) =>
  Object.fromEntries(
    addresses.map((address, i) => [
      address,
      wei(10)
        .pow(18)
        .mul(1000 + i * 3571),
    ])
  );

const snapshotOf = (addresses = jurors) =>
  buildSnapshot({
    stakes: stakesOf(addresses),
    droppedAmount,
    startDate,
    endDate,
    blockHeight: endBlock,
    adjustedSupply,
  });
const options = {
  chainId: 1,
  startDate,
  endDate,
  endBlock,
  adjustedSupply,
  excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
};
const check = (snapshot, overrides = {}) => assertSnapshotIntegrity(snapshot, { ...options, ...overrides });

describe("snapshot integrity", () => {
  it("accepts a snapshot built the way createSnapshot builds them", () => {
    const { claims, dust } = check(snapshotOf());
    assert.equal(claims, jurors.length);
    assert.ok(dust.lt(jurors.length));
  });

  it("stops on a claim that isn't its pro-rata share of the drop", () => {
    const snapshot = snapshotOf();
    const claim = snapshot.merkleTree.claims[jurors[0]];
    claim.value = json(wei(claim.value).add(1));
    assert.throws(() => check(snapshot), violates(/pro-rata share/));
  });

  it("stops when the drop or the total stake doesn't match the claims", () => {
    const moreDropped = snapshotOf();
    moreDropped.droppedAmount = json(droppedAmount.add(1000000));
    assert.throws(() => check(moreDropped), violates(/pro-rata share/));
    const moreStaked = snapshotOf();
    moreStaked.averageTotalStaked = json(wei(moreStaked.averageTotalStaked).mul(2));
    assert.throws(() => check(moreStaked), violates(/pro-rata share|average stakes add up/));
  });

  it("stops on a node that isn't the claim's leaf", () => {
    const snapshot = snapshotOf();
    snapshot.merkleTree.claims[jurors[0]].node = snapshot.merkleTree.claims[jurors[1]].node;
    assert.throws(() => check(snapshot), violates(/node is not keccak256/));
  });

  it("stops on a proof MerkleRedeem would reject", () => {
    const altered = snapshotOf();
    const proof = altered.merkleTree.claims[jurors[2]].proof;
    proof[0] = `0x${proof[0].slice(2, 65)}${proof[0][65] === "0" ? "1" : "0"}`;
    assert.throws(() => check(altered), violates(/does not verify against root/));

    const truncated = snapshotOf();
    truncated.merkleTree.claims[jurors[2]].proof.pop();
    assert.throws(() => check(truncated), violates(/does not verify against root/));

    const otherRoot = snapshotOf();
    otherRoot.merkleTree.root = utils.keccak256(otherRoot.merkleTree.root);
    assert.throws(() => check(otherRoot), violates(/does not verify against root/));
  });

  it("stops on a claim slipped in with another claim's proof", () => {
    const snapshot = snapshotOf();
    const intruder = utils.getAddress(utils.hexZeroPad("0xbad", 20));
    const original = snapshot.merkleTree.claims[jurors[0]];
    // its amount is a valid share and its node a valid leaf, but no proof can tie it to the root
    snapshot.merkleTree.claims[intruder] = {
      ...original,
      node: claimLeaf(intruder, wei(original.value)),
    };
    assert.throws(() => check(snapshot), violates(new RegExp(`${intruder}'s proof does not verify`)));
  });

  it("stops when the root commits to claims the snapshot doesn't list", () => {
    const missing = snapshotOf();
    delete missing.merkleTree.claims[jurors[4]];
    assert.throws(() => check(missing), violates(/does not commit to exactly/));

    const wider = snapshotOf();
    wider.merkleTree.width += 1;
    assert.throws(() => check(wider), violates(/does not commit to exactly/));
  });

  it("stops when the claims don't add up to totalClaimable", () => {
    const snapshot = snapshotOf();
    snapshot.totalClaimable = json(wei(snapshot.totalClaimable).add(1));
    assert.throws(() => check(snapshot), violates(/totalClaimable/));
  });

  it("stops on a claim for a KIP-86 address", () => {
    const cooperative = utils.getAddress(KIP_86_EXCLUDED_ADDRESSES[4]);
    assert.throws(() => check(snapshotOf([...jurors, cooperative])), violates(/KIP-86 excluded address/));
  });

  it("stops on a claim the Court frontend can't find, or for the zero address", () => {
    const lowercase = snapshotOf();
    const claims = lowercase.merkleTree.claims;
    claims[jurors[3].toLowerCase()] = claims[jurors[3]];
    delete claims[jurors[3]];
    assert.throws(() => check(lowercase), violates(/not a checksummed, non-zero address/));

    assert.throws(
      () => check(snapshotOf([...jurors, constants.AddressZero])),
      violates(/not a checksummed, non-zero address/)
    );
  });

  it("stops on a snapshot of another period, block or supply", () => {
    const snapshot = snapshotOf();
    assert.throws(() => check(snapshot, { startDate: new Date("2026-08-01T00:00:00.000Z") }), violates(/covers/));
    assert.throws(() => check(snapshot, { endDate: new Date("2026-11-01T00:00:00.000Z") }), violates(/covers/));
    assert.throws(() => check(snapshot, { endBlock: endBlock + 1 }), violates(/read up to block/));
    assert.throws(() => check(snapshot, { adjustedSupply: adjustedSupply.add(1) }), violates(/adjusted supply/));
  });

  it("stops on an empty or malformed snapshot", () => {
    const empty = snapshotOf();
    empty.merkleTree.claims = {};
    assert.throws(() => check(empty), violates(/has no claims/));
    const noRoot = snapshotOf();
    noRoot.merkleTree.root = "0x";
    assert.throws(() => check(noRoot), violates(/no valid merkle tree/));
    const nothingDropped = buildSnapshot({
      stakes: stakesOf(jurors),
      droppedAmount: wei(0),
      startDate,
      endDate,
      blockHeight: endBlock,
      adjustedSupply,
    });
    assert.throws(() => check(nothingDropped), violates(/drops 0 wei/));
  });
});

describe("reward", () => {
  // the September 2026 run
  const september = {
    period: "2026-09",
    totalSupply: wei("915528222079312772774086827"),
    cooperativePNK: wei("160949156368932919934943148"),
    adjustedSupply,
    totalPNKStaked: wei("318677498394732788487783457"),
    lastamount: wei("3720848084298438935337425"),
    target: wei(354000000),
    fullReward: wei("3466621659857479896861946"),
  };

  it("accepts the September 2026 run", () => {
    assertReward(september);
  });

  it("stops on a target that isn't the one scheduled for the period", () => {
    assert.throws(() => assertReward({ ...september, target: wei(352000000) }), violates(/schedule sets 354000000/));
  });

  it("stops when the exclusions or the stake don't fit in the supply", () => {
    const { totalSupply } = september;
    assert.throws(
      () => assertReward({ ...september, cooperativePNK: totalSupply, adjustedSupply: wei(0) }),
      violates(/not less than the total supply/)
    );
    assert.throws(
      () => assertReward({ ...september, adjustedSupply: adjustedSupply.sub(1) }),
      violates(/is not the total supply/)
    );
    assert.throws(() => assertReward({ ...september, totalPNKStaked: adjustedSupply }), violates(/not a share/));
    assert.throws(() => assertReward({ ...september, totalPNKStaked: wei(0) }), violates(/not a share/));
  });

  it("stops on a reward the formula can't give", () => {
    const { lastamount } = september;
    const ceiling = lastamount.mul(1354000000).div(1000000000);
    assertReward({ ...september, fullReward: ceiling });
    assert.throws(
      () => assertReward({ ...september, fullReward: ceiling.add(1) }),
      violates(/outside what the formula/)
    );
    assert.throws(() => assertReward({ ...september, fullReward: wei(0) }), violates(/outside what the formula/));
  });

  it("schedules a target of 33% for 2025-09, 0.2 points more each period, up to 50%", () => {
    const expected = {
      "2025-09": 330000000,
      "2025-12": 336000000,
      "2026-08": 352000000,
      "2026-09": 354000000,
      "2032-10": 500000000,
      "2032-11": 500000000,
      "2040-01": 500000000,
    };
    for (const [period, target] of Object.entries(expected)) assert.equal(scheduledTarget(period).toNumber(), target);
    for (const period of ["2025-08", "2026-13", "26-09", "2026-9"]) {
      assert.throws(() => scheduledTarget(period), InvariantError, period);
    }
  });

  it("agrees with the floating-point target the run computes, for every period", () => {
    // what getDatesAndPeriod in cli.js computes, so the check can't stop a correct run in some later month
    for (let periods = 0; periods < 300; periods++) {
      const floating = Math.floor(Math.min(33 + 0.2 * periods, 50) * 1e7);
      const period = new Date(Date.UTC(2025, 8 + periods, 1)).toISOString().slice(0, 7);
      assert.equal(scheduledTarget(period).toNumber(), floating, period);
    }
  });
});

describe("drop split", () => {
  const [mainnet, gnosis] = CHAINS;
  const fullReward = wei("3466621659857479896861946");
  const drops = [
    { chainId: 1, pnkDropRatio: mainnet.pnkDropRatio, droppedAmount: wei("3119959493871731907175751") },
    { chainId: 100, pnkDropRatio: gnosis.pnkDropRatio, droppedAmount: wei("346662165985747989686194") },
  ];

  it("accepts each chain dropping its share of the reward", () => {
    assertDropSplit({ fullReward, drops });
  });

  it("stops when the ratios don't add up to the whole reward", () => {
    const short = [drops[0], { ...drops[1], pnkDropRatio: gnosis.pnkDropRatio.sub(1) }];
    assert.throws(() => assertDropSplit({ fullReward, drops: short }), violates(/add up to 999999999/));
  });

  it("stops on a chain dropping more or less than its share", () => {
    for (const delta of [1, -1]) {
      const off = [drops[0], { ...drops[1], droppedAmount: drops[1].droppedAmount.add(delta) }];
      assert.throws(
        () => assertDropSplit({ fullReward, drops: off }),
        violates(/its share of the reward/),
        `a drop ${delta} wei off its share`
      );
    }
  });
});

describe("pinned block", () => {
  // a block every 12 seconds: block 100 is the first at 1200
  const chain = new FakeChain({ timestampOf: (number) => number * 12 });
  const date = new Date(1200 * 1000);

  it("accepts the last block before the date", async () => {
    await assertPinnedBlock({ provider: chain, chainId: 1, blockTag: 99, date });
  });

  it("stops on any other block", async () => {
    for (const blockTag of [98, 100]) {
      await assert.rejects(
        assertPinnedBlock({ provider: chain, chainId: 1, blockTag, date }),
        violates(/is not the last one before/)
      );
    }
  });
});

describe("seeding", () => {
  const [mainnet] = CHAINS;
  const rootA = utils.keccak256("0xaa");
  const rootB = utils.keccak256("0xbb");
  const week = 67;

  const merkleRedeem = (roots, token = mainnet.token) => {
    const chain = new FakeChain();
    chain.contract(
      mainnet.merkleRedeem,
      ["function token() view returns (address)", "function weekMerkleRoots(uint256) view returns (bytes32)"],
      { token: () => token, weekMerkleRoots: ([n]) => roots[n.toNumber()] ?? constants.HashZero }
    );
    return chain;
  };
  const seeding = (provider, root = rootA) =>
    assertSeedingWeek({
      provider,
      chainId: 1,
      merkleRedeem: mainnet.merkleRedeem,
      token: mainnet.token,
      week,
      root,
    });

  it("accepts the week right after the last seeded one", async () => {
    assert.equal(await seeding(merkleRedeem({ 66: rootB })), "unseeded");
  });

  it("reports a week already seeded with this exact root", async () => {
    assert.equal(await seeding(merkleRedeem({ 66: rootB, 67: rootA })), "seeded");
  });

  it("stops on a week seeded with another root", async () => {
    await assert.rejects(seeding(merkleRedeem({ 66: rootB, 67: rootB })), violates(/already seeded with root/));
  });

  it("stops when the previous week isn't seeded", async () => {
    await assert.rejects(seeding(merkleRedeem({ 65: rootB })), violates(/week 66 has no root/));
  });

  it("stops when MerkleRedeem distributes another token", async () => {
    await assert.rejects(seeding(merkleRedeem({ 66: rootB }, CHAINS[1].token)), violates(/distributes/));
  });
});

describe("claims checked by the deployed contract", () => {
  const [mainnet] = CHAINS;
  const week = 67;

  // MerkleRedeem.verifyClaim against the root in weekMerkleRoots' storage slot, which the run overrides
  const merkleRedeem = ({ rejecting } = {}) => {
    const chain = new FakeChain();
    const slotOf = (n) => utils.keccak256(utils.defaultAbiCoder.encode(["uint256", "uint256"], [n, 2]));
    chain.contract(
      mainnet.merkleRedeem,
      ["function verifyClaim(address, uint256, uint256, bytes32[]) view returns (bool)"],
      {
        verifyClaim: ([address, n, value, proof], { storage }) => {
          if (address === rejecting) throw new Revert();
          const root = storage[`${mainnet.merkleRedeem.toLowerCase()}:${slotOf(n)}`] ?? constants.HashZero;
          return verifyMerkleProof(proof, root, claimLeaf(address, value));
        },
      }
    );
    return chain;
  };
  const claimable = (provider, snapshot) =>
    assertClaimableOnChain({
      provider,
      chainId: 1,
      merkleRedeem: mainnet.merkleRedeem,
      week,
      snapshot,
      batchSize: 4,
    });

  it("accepts a snapshot whose every claim the contract verifies, in batches", async () => {
    assert.equal(await claimable(merkleRedeem(), snapshotOf()), jurors.length);
  });

  it("stops on a claim the contract rejects", async () => {
    const snapshot = snapshotOf();
    const claim = snapshot.merkleTree.claims[jurors[5]];
    claim.value = json(wei(claim.value).sub(1));
    await assert.rejects(claimable(merkleRedeem(), snapshot), violates(new RegExp(`rejects ${jurors[5]}'s claim`)));
  });

  it("stops on a claim whose check reverts", async () => {
    await assert.rejects(
      claimable(merkleRedeem({ rejecting: jurors[8] }), snapshotOf()),
      violates(new RegExp(`rejects ${jurors[8]}'s claim`))
    );
  });

  it("needs a JSON-RPC provider to override the contract's storage", async () => {
    const provider = merkleRedeem();
    provider.send = undefined;
    await assert.rejects(claimable(provider, snapshotOf()), violates(/needs a JSON-RPC provider/));
  });
});
