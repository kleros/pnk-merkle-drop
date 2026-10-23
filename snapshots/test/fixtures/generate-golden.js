#!/usr/bin/env node
/*
 * Generates test/fixtures/golden-<period>.json, the inputs test/golden.test.js reproduces a published
 * period from: each chain's StakeSet events as the subgraph serves them, the period's first block, and
 * the published snapshot's sha256, root and amounts. It also records the formula's inputs, read back
 * from the previous period's published snapshots, and the drops it produced.
 *
 * Needs the RPC and subgraph URLs from .env. Run it from snapshots/, for a period whose snapshots are
 * listed in snapshots.json and seeded on-chain:
 *
 *   node test/fixtures/generate-golden.js 2026-08
 *
 * Only the events that can affect the snapshot are kept: for each address, the last one before the
 * period starts, every one inside it, and its first one ever, which places it in the order the claims
 * are listed in. The averaging never reads the others, as it starts from the last event before the
 * period. The generator checks that the kept events give the same averages, in the same order, as all
 * of them; test/golden.test.js then checks they reproduce the published snapshot byte for byte.
 */
import { createHash } from "crypto";
import dotenv from "dotenv";
import { BigNumber, Contract, getDefaultProvider } from "ethers";
import { writeFileSync } from "fs";
import { CHAINS, KIP_86_EXCLUDED_ADDRESSES } from "../../src/config.js";
import { getAverageStakesByAddress } from "../../src/create-snapshot-from-block-limits.js";
import { createBlockFetchers } from "../../src/helpers/blocks.js";
import { IPFS_GATEWAY, fetchSnapshotsIndex, snapshotFilename } from "../../src/helpers/published-snapshots.js";
import { getStakeSets } from "../../src/helpers/subgraph-events.js";

dotenv.config();

const period = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(period ?? "")) throw new Error("Usage: node test/fixtures/generate-golden.js YYYY-MM");
const [year, month] = period.split("-").map(Number);
const startDate = new Date(Date.UTC(year, month - 1, 1));
const endDate = new Date(Date.UTC(year, month, 1));
const previousPeriod = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);

const fetchText = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} responded ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
};

const main = async () => {
  const index = await fetchSnapshotsIndex();
  const published = async (chainId, ofPeriod) => {
    const filename = snapshotFilename(chainId, ofPeriod);
    const entries = index[String(chainId)];
    const entry = entries.filter((it) => it.endsWith(`/${filename}`)).pop();
    if (!entry) throw new Error(`snapshots.json has no ${filename}`);
    const text = await fetchText(`${IPFS_GATEWAY}/${entry}`);
    return { entry, week: entries.lastIndexOf(entry), text, json: JSON.parse(text) };
  };

  const sha256 = (text) => createHash("sha256").update(text).digest("hex");

  const chains = [];
  for (const chain of CHAINS) {
    const provider = getDefaultProvider(process.env[chain.rpcEnvVar]);
    const snapshot = await published(chain.chainId, period);
    const endBlock = snapshot.json.blockHeight;
    const startBlock = await createBlockFetchers(provider).findFirstAfter(startDate);

    // The root the published file carries has to be the one seeded at its week.
    const merkleRedeem = new Contract(
      chain.merkleRedeem,
      ["function weekMerkleRoots(uint256) view returns (bytes32)"],
      provider
    );
    const seededRoot = await merkleRedeem.weekMerkleRoots(snapshot.week);
    if (seededRoot !== snapshot.json.merkleTree.root) {
      throw new Error(
        `Chain ${chain.chainId} week ${snapshot.week} is seeded with ${seededRoot}, not the published root`
      );
    }

    // The Gnosis subgraph is served through The Graph's gateway, and not every indexer behind it serves
    // the same events: one has been seen reporting log indexes off by one, some wrapped around to near
    // 2^32, and an event twice. So the events have to come out the same twice, with plausible indexes.
    const events = await getStakeSets(chain.fromBlock, endBlock, chain.chainId);
    const again = await getStakeSets(chain.fromBlock, endBlock, chain.chainId);
    const asText = (list) =>
      JSON.stringify(list.map((e) => [e.blockNumber, e.logIndex, e.args._address, `${e.args._newTotalStake}`]));
    if (asText(events) !== asText(again) || events.some((event) => event.logIndex > 100000)) {
      throw new Error(`Chain ${chain.chainId}: the subgraph's indexers disagree on the events, run this again`);
    }
    // Each address's first event is kept too: the snapshot lists claims in the order their addresses
    // first appear in the events, and that order is part of the published bytes.
    const first = new Map();
    const lastBefore = new Map();
    for (const event of events) {
      if (!first.has(event.args._address)) first.set(event.args._address, event);
      if (event.blockNumber < startBlock) lastBefore.set(event.args._address, event);
    }
    const kept = events.filter(
      (event) =>
        event.blockNumber >= startBlock ||
        lastBefore.get(event.args._address) === event ||
        first.get(event.args._address) === event
    );

    // The reduced events have to give exactly the averages all of them give.
    const full = getAverageStakesByAddress({ startBlock, endBlock }, events, KIP_86_EXCLUDED_ADDRESSES);
    const reduced = getAverageStakesByAddress({ startBlock, endBlock }, kept, KIP_86_EXCLUDED_ADDRESSES);
    if (JSON.stringify(full) !== JSON.stringify(reduced))
      throw new Error(`Chain ${chain.chainId}: reduced events differ`);

    chains.push({
      chainId: chain.chainId,
      fromBlock: chain.fromBlock,
      startBlock,
      endBlock,
      droppedAmount: BigNumber.from(snapshot.json.droppedAmount).toString(),
      adjustedSupply: BigNumber.from(snapshot.json.adjustedSupply).toString(),
      published: {
        entry: snapshot.entry,
        week: snapshot.week,
        root: snapshot.json.merkleTree.root,
        sha256: sha256(snapshot.text),
      },
      // one event per line, as "address,block number,log index,new total stake"
      events: kept.map((event) =>
        [
          event.args._address.toLowerCase(),
          event.blockNumber,
          event.logIndex,
          event.args._newTotalStake.toString(),
        ].join(",")
      ),
    });
    console.log(`Chain ${chain.chainId}: kept ${kept.length} of ${events.length} events`);
  }

  // The formula's inputs: the previous period's drops and average stakes, as published.
  const previous = await Promise.all(CHAINS.map((chain) => published(chain.chainId, previousPeriod)));
  const sum = (values) => values.reduce((total, value) => total.add(BigNumber.from(value)), BigNumber.from(0));
  const formula = {
    lastamount: sum(previous.map(({ json }) => json.droppedAmount)).toString(),
    totalPNKStaked: sum(previous.map(({ json }) => json.averageTotalStaked)).toString(),
    adjustedSupply: chains[0].adjustedSupply,
    drops: Object.fromEntries(chains.map(({ chainId, droppedAmount }) => [chainId, droppedAmount])),
    previous: previous.map(({ entry }) => entry),
  };

  const file = new URL(`./golden-${period}.json`, import.meta.url);
  // indented the way prettier formats JSON in this repo, so that lint-staged leaves it as it is
  writeFileSync(file, JSON.stringify({ period, startDate, endDate, formula, chains }, null, 2) + "\n");
  console.log(`Wrote ${file.pathname}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
