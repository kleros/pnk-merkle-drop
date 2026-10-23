#!/usr/bin/env node
/*
 * Checks snapshot files again right before seeding, by anyone, from the files themselves:
 *
 *   node verify-snapshot.js .cache/snapshot-2026-09.json .cache/xdai-snapshot-2026-09.json
 *
 * For each file: the merkle tree and the amounts (see assertSnapshotIntegrity), that it covers its whole
 * month up to the month's last block, the week it would be seeded as, and every claim against the deployed
 * MerkleRedeem. The week is the file's position in https://court.kleros.io/snapshots.json, which the Court
 * frontend reads as its week, or the position it will be appended at. Given both chains' files for a period,
 * it also checks that they split one reward. Once everything has passed, it prints, for each week that
 * isn't seeded yet, the seeding transaction the way the hardware wallet will show it, to hold against the
 * device when signing.
 *
 * It doesn't repeat the run's reward, supply or KIP-86 checks, and it takes the stakes and the adjusted
 * supply from the files, so a file that is wrong but consistent with itself passes, whether its inputs
 * were wrong or it was forged. What it does bound is the loss: claims can't add up to more than the amount
 * the device will show. Needs the RPC URLs in .env. Exits non-zero on any failure.
 */
import dotenv from "dotenv";
import { BigNumber, getDefaultProvider } from "ethers";
import { readFileSync } from "fs";
import { basename } from "path";
import { CHAINS, KIP_86_EXCLUDED_ADDRESSES } from "./src/config.js";
import { fetchSnapshotsIndex, snapshotFilename } from "./src/helpers/published-snapshots.js";
import { redact } from "./src/helpers/redact.js";
import {
  assertClaimableOnChain,
  assertDropSplit,
  assertPinnedBlock,
  assertSeedingWeek,
  assertSnapshotIntegrity,
} from "./src/invariants.js";
import { seedingInstructions } from "./src/seeding.js";

dotenv.config();

// The week a chain's snapshot of `period` is seeded as: its position in the index, or the next one.
function weekOf(index, chainId, period) {
  const entries = index[String(chainId)] ?? [];
  const listed = entries.findIndex((entry) => entry.endsWith(`/${snapshotFilename(chainId, period)}`));
  if (listed !== -1) return listed;
  const [year, month] = period.split("-").map(Number);
  const previous = snapshotFilename(chainId, new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7));
  if (!entries.length || !entries[entries.length - 1].endsWith(`/${previous}`)) {
    throw new Error(`snapshots.json doesn't end with ${previous}, so the week ${period} would be seeded as is unknown`);
  }
  return entries.length;
}

const main = async () => {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("Usage: node verify-snapshot.js <snapshot file>...");
  const index = await fetchSnapshotsIndex();

  const verified = [];
  for (const file of files) {
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    const period = String(snapshot.startDate).slice(0, 7);
    const chain = CHAINS.find(({ chainId }) => snapshotFilename(chainId, period) === basename(file));
    if (!chain) throw new Error(`${file} isn't named like a ${period} snapshot of any chain the drop is on`);
    // two candidates for one week would each pass, and print a seeding block of its own
    if (verified.some((v) => v.chain.chainId === chain.chainId && v.period === period)) {
      throw new Error(`${file} is a second ${period} snapshot of chain ${chain.chainId}: give one file per chain`);
    }
    const provider = getDefaultProvider(process.env[chain.rpcEnvVar]);
    // the period's bounds come from the calendar, not the file, so a file that doesn't cover the whole month fails
    const [year, month] = period.split("-").map(Number);
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 1));
    const root = snapshot.merkleTree.root;
    console.log(`${file}: chain ${chain.chainId}, ${period}, root ${root}`);

    const { claims, dust } = assertSnapshotIntegrity(snapshot, {
      chainId: chain.chainId,
      startDate,
      endDate,
      endBlock: snapshot.blockHeight,
      adjustedSupply: BigNumber.from(snapshot.adjustedSupply),
      excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
    });
    console.log(`  ✓ ${claims} claims, each its pro-rata share, all proving against the root (${dust} wei of dust)`);
    await assertPinnedBlock({ provider, chainId: chain.chainId, blockTag: snapshot.blockHeight, date: endDate });
    console.log(`  ✓ read up to block ${snapshot.blockHeight}, the last one before ${endDate.toISOString()}`);

    const week = weekOf(index, chain.chainId, period);
    const status = await assertSeedingWeek({
      provider,
      chainId: chain.chainId,
      merkleRedeem: chain.merkleRedeem,
      token: chain.token,
      week,
      root,
    });
    console.log(
      status === "seeded"
        ? `  ✓ week ${week} is already seeded with this root`
        : `  ✓ week ${week} is the next one to seed, after week ${week - 1}`
    );
    await assertClaimableOnChain({
      provider,
      chainId: chain.chainId,
      merkleRedeem: chain.merkleRedeem,
      week,
      snapshot,
    });
    console.log(`  ✓ the deployed MerkleRedeem ${chain.merkleRedeem} accepts every claim as week ${week}`);
    verified.push({ chain, period, snapshot, week, root, status });
  }

  // Both chains' files of one period have to split a single reward, of which each holds its share.
  for (const period of new Set(verified.map(({ period }) => period))) {
    const ofPeriod = verified.filter((v) => v.period === period);
    if (ofPeriod.length !== CHAINS.length) {
      console.log(
        `${period}: ⚠ not every chain's file was given, so the split of the reward between them wasn't checked`
      );
      continue;
    }
    const drops = ofPeriod.map(({ chain, snapshot }) => ({
      chainId: chain.chainId,
      pnkDropRatio: chain.pnkDropRatio,
      droppedAmount: BigNumber.from(snapshot.droppedAmount),
    }));
    const dropped = drops.reduce((sum, { droppedAmount }) => sum.add(droppedAmount), BigNumber.from(0));
    // the shares round down, so the reward is at most a wei per chain more than they add up to, and now and
    // then two rewards give the same shares
    const rewards = [...Array(CHAINS.length).keys()]
      .map((extra) => dropped.add(extra))
      .filter((fullReward) => {
        try {
          assertDropSplit({ fullReward, drops });
          return true;
        } catch (error) {
          return false;
        }
      });
    if (!rewards.length) throw new Error(`The ${period} files' drops aren't the chains' shares of one reward`);
    const supplies = new Set(ofPeriod.map(({ snapshot }) => BigNumber.from(snapshot.adjustedSupply).toString()));
    if (supplies.size !== 1) throw new Error(`The ${period} files record different adjusted supplies`);
    console.log(
      `${period}: ✓ the chains' drops, ${dropped} wei in all, are their shares of one reward of ` +
        `${rewards.join(" or ")} wei, over one adjusted supply (the reward itself isn't recomputed here)`
    );
  }

  // Only once every check above has passed: what to sign, for each week that isn't seeded yet.
  const toSeed = verified.filter(({ status }) => status === "unseeded");
  if (toSeed.length) console.log("\nAll checks passed. For each seeding, the device has to show what follows:");
  for (const { chain, snapshot, week, root } of toSeed) {
    const amount = BigNumber.from(snapshot.droppedAmount);
    for (const line of seedingInstructions({ ...chain, week, root, amount })) console.log(line);
  }
};

main().catch((error) => {
  console.error(`\n✖ ${error.name === "InvariantError" ? "Invariant violated: " : ""}${redact(error.message)}`);
  process.exit(1);
});
