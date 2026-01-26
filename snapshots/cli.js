#!/usr/bin/env node
import dotenv from "dotenv";
import { BigNumber, Contract, getDefaultProvider } from "ethers";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import { createSnapshotCreator } from "./src/create-snapshot-from-block-limits.js";
import { formatEther } from "ethers/lib/utils.js";
import fs from "fs";
import { fileToIpfs } from "./src/fileToIpfs.js";
import { addTransactionToBatch, writeTransactionBatch, createNewBatch } from "./src/helpers/tx-builder.js";

dotenv.config();

dayjs.extend(utc);

const chains = [
  {
    version: "v1",
    chainId: 1,
    chainShortName: "eth",
    blocksPerSecond: 0.066667,
    klerosLiquidAddress: "0x988b3a538b618c7a603e1c11ab82cd16dbe28069",
    token: "0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d",
    pnkDropRatio: BigNumber.from("800000000"),
    fromBlock: 7300000,
    provider: getDefaultProvider(process.env.PNK_DROP_JSON_RPC_URL),
    merkleDropAddress: "0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38",
    safeAddress: "0x3CDe6e49AC61B268dBFce31B73DEA440c4E09162",
  },
  {
    version: "v1",
    chainId: 100,
    chainShortName: "gno",
    blocksPerSecond: 0.2,
    klerosLiquidAddress: "0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002",
    token: "0xcb3231aBA3b451343e0Fddfc45883c842f223846",
    pnkDropRatio: BigNumber.from("100000000"),
    fromBlock: 16895601,
    provider: getDefaultProvider("https://rpc.gnosischain.com"),
    merkleDropAddress: "0xf1A9589880DbF393F32A5b2d5a0054Fa10385074",
    safeAddress: "0x3CDe6e49AC61B268dBFce31B73DEA440c4E09162",
  },
  {
    version: "v2",
    chainId: 42161,
    chainShortName: "arb",
    blocksPerSecond: 0.26,
    klerosCoreAddress: "0x991d2df165670b9cac3B022f4B68D65b664222ea",
    token: "0x330bD769382cFc6d50175903434CCC8D206DCAE5",
    pnkDropRatio: BigNumber.from("1000000000"),
    fromBlock: 272063254,
    provider: getDefaultProvider(process.env.INFURA_ARB_ONE_RPC),
    merkleDropAddress: "0x2a23B84078b287753A91C522c3bB3b6B32f6F8f1",
    safeAddress: "0x66e8DE9B42308c6Ca913D1EE041d6F6fD037A57e",
  },
];

const argv = yargs(hideBin(process.argv))
  .strict(true)
  .locale("en")
  .usage(`Usage: $0 --lastamount={n}`)
  .epilogue("Alternatively set the same params in the .env file. Check .env.example.")
  .option("lastamount", {
    description: "The amount of tokens, in wei, that were distributed in the last period",
  })
  .option("json-rpc-url", {
    description: "The amount of tokens, in wei, that were distributed in the last period",
  })
  .string(["lastamount, json-rpc-url"]).argv;

const normalizeArgs = ({ lastamount }) => ({
  lastamount: BigNumber.from(String(lastamount)),
});

const { lastamount } = normalizeArgs(argv);

const formatDateMonth = (date) => dayjs(date).utc().format("YYYY-MM");

const getDatesAndPeriod = () => {
  const currentDate = new Date(); // Current date in local time zone
  const currentMonth = currentDate.getUTCMonth(); // Get current month in UTC
  const currentYear = currentDate.getUTCFullYear(); // Get current year in UTC

  // Calculate the start date as the first day of the previous month in UTC
  const startDate = new Date(Date.UTC(currentYear, currentMonth - 1, 1));

  // Calculate the end date as the first day of the current month in UTC
  const endDate = new Date(Date.UTC(currentYear, currentMonth, 1));

  const previousDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));

  // Calculate the periods based on the start date
  const baseYear = 2025;
  const baseMonth = 8; // September is 8 in Date.UTC
  const monthDiff = (currentYear - baseYear) * 12 + currentMonth - baseMonth - 1;

  // target starts at 33 % for September 2025 and increases by 0.2 % each period, max 50 %
  const targetPercentage = Math.min(33 + 0.2 * monthDiff, 50); // % as float
  const target = BigNumber.from(Math.floor(targetPercentage * 1e7)); // scale to 1 e-7 units
  // v1's mainnetPeriod starts at 55 for September 2025 and also increases by 1 each period
  // v1's gnosisPeriod starts at 50 for September 2025 and increases by 1 each period
  // v2's arbitrumPeriod starts at 21 for September 2025 and increases by 1 each period
  // only used for _week argument in merkledrop.seedAllocations()
  const periods = { 1: 55 + monthDiff, 100: 50 + monthDiff, 42161: 21 + monthDiff };

  return { startDate, endDate, previousDate, target, periods };
};

const main = async () => {
  // get the utc dates of the period.
  const { startDate, endDate, previousDate, target, periods } = getDatesAndPeriod();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  CALCULATING REWARDS: ${startDate.toISOString().slice(0, 7)} → ${endDate.toISOString().slice(0, 7)}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // for each chain, count the "average" total pnk staked of the month.
  // to get this value, we can run the entire snapshot creator function,
  // create the entire merkle tree. not efficient but safer than modifying
  // working legacy.
  // getting this value implies getting it for all chains.
  const getTotalPNKStaked = async () => {
    let sum = BigNumber.from(0);
    console.log(
      `[1/3] Fetching stake data from ${previousDate.toISOString().slice(0, 7)} → ${startDate
        .toISOString()
        .slice(0, 7)} (for formula)\n`
    );
    for (const chain of chains) {
      const createSnapshot = await createSnapshotCreator({
        provider: chain.provider,
        klerosLiquidAddress: chain.klerosLiquidAddress,
        klerosCoreAddress: chain.klerosCoreAddress,
        droppedAmount: BigNumber.from(0), // we're not awarding anything, just counting.
      });

      const snapshot = await createSnapshot({
        fromBlock: chain.fromBlock,
        startDate: previousDate,
        endDate: startDate,
      });
      const inPnk = parseFloat(formatEther(snapshot.averageTotalStaked));
      const displayAmount = inPnk >= 1000000 ? `${(inPnk / 1000000).toFixed(2)}M` : `${(inPnk / 1000).toFixed(0)}K`;
      console.log(`      Chain ${chain.chainId}: ${displayAmount} PNK (${snapshot.averageTotalStaked} wei) staked`);
      sum = sum.add(snapshot.averageTotalStaked);
    }
    return sum;
  };
  const totalPNKStaked = await getTotalPNKStaked();

  // lets compute the formula to figure out how much will be awarded in total this month
  const pnkSupplyChecker = new Contract(
    chains[0].token,
    ["function totalSupply() view returns (uint256)"],
    chains[0].provider
  );
  const totalSupply = await pnkSupplyChecker.totalSupply();
  const totalInPnk = parseFloat(formatEther(totalPNKStaked));
  const totalDisplay =
    totalInPnk >= 1000000 ? `${(totalInPnk / 1000000).toFixed(2)}M` : `${(totalInPnk / 1000).toFixed(0)}K`;
  console.log(`      Total: ${totalDisplay} PNK (${totalPNKStaked} wei) staked\n`);
  // basis points: 9 zeroes
  const basis = BigNumber.from(1000000000);
  const stakePercent = totalPNKStaked.mul(basis).div(totalSupply);
  const onePlusStakeMinusTarget = basis.add(target).sub(stakePercent);
  const fullReward = lastamount.mul(onePlusStakeMinusTarget).div(basis);

  console.log("[2/3] Calculating reward amount\n");
  const stakePercentDisplay = (stakePercent.div(BigNumber.from(100000)).toNumber() / 100).toFixed(2);
  const targetDisplay = (target.div(BigNumber.from(100000)).toNumber() / 100).toFixed(2);
  const multiplierDisplay = (onePlusStakeMinusTarget.toNumber() / 10000000).toFixed(2);
  const rewardInPnk = parseFloat(formatEther(fullReward));
  const rewardDisplay =
    rewardInPnk >= 1000000 ? `${(rewardInPnk / 1000000).toFixed(2)}M` : `${(rewardInPnk / 1000).toFixed(0)}K`;
  console.log(`      Stake %: ${stakePercentDisplay}%`);
  console.log(`      Target %: ${targetDisplay}%`);
  console.log(`      Multiplier: ${multiplierDisplay}%`);
  console.log(
    `      Total Reward for ${startDate
      .toISOString()
      .slice(0, 7)}: ${fullReward.toString()} wei (~${rewardDisplay} PNK)\n`
  );

  console.log(
    `[3/3] Generating snapshots for ${startDate.toISOString().slice(0, 7)} → ${endDate.toISOString().slice(0, 7)}\n`
  );

  const snapshotInfos = [];
  let currentMonthTotalStaked = BigNumber.from(0);
  for (const c of chains) {
    const droppedAmount = fullReward.mul(c.pnkDropRatio).div(basis);
    const droppedInPnk = parseFloat(formatEther(droppedAmount));
    const droppedDisplay =
      droppedInPnk >= 1000000 ? `${(droppedInPnk / 1000000).toFixed(2)}M` : `${(droppedInPnk / 1000).toFixed(0)}K`;
    const createSnapshot = await createSnapshotCreator({
      provider: c.provider,
      klerosLiquidAddress: c.klerosLiquidAddress,
      klerosCoreAddress: c.klerosCoreAddress,
      droppedAmount,
    });
    const snapshot = await createSnapshot({ fromBlock: c.fromBlock, startDate, endDate });
    const stakedInPnk = parseFloat(formatEther(snapshot.averageTotalStaked));
    const stakedDisplay =
      stakedInPnk >= 1000000 ? `${(stakedInPnk / 1000000).toFixed(2)}M` : `${(stakedInPnk / 1000).toFixed(0)}K`;
    console.log(`      Chain ${c.chainId}: ${stakedDisplay} PNK (${snapshot.averageTotalStaked} wei) staked`);
    console.log(`        └─ Reward: ${droppedDisplay} PNK (${droppedAmount} wei)`);
    currentMonthTotalStaked = currentMonthTotalStaked.add(snapshot.averageTotalStaked);
    snapshotInfos.push({
      filename: `${c.chainShortName}-snapshot-${startDate.toISOString().slice(0, 7)}.json`,
      chain: c,
      snapshot,
      period: periods[c.chainId],
    });
  }
  const currentTotalInPnk = parseFloat(formatEther(currentMonthTotalStaked));
  const currentTotalDisplay =
    currentTotalInPnk >= 1000000
      ? `${(currentTotalInPnk / 1000000).toFixed(2)}M`
      : `${(currentTotalInPnk / 1000).toFixed(0)}K`;
  console.log(`      Total Staked: ${currentTotalDisplay} PNK (${currentMonthTotalStaked} wei)\n`);
  console.log("───────────────────────────────────────────────────────────────");

  // paste these ipfs hashes into kleros/court's claim-modal file so people can claim the rewards.
  console.log("\nIPFS URLs:");
  for (const sinfo of snapshotInfos) {
    const path = `.cache/${sinfo.filename}`;
    fs.writeFileSync(path, JSON.stringify(sinfo.snapshot));
    const ipfsPath = await fileToIpfs(path);
    console.log(`  https://cdn.kleros.link/ipfs/${ipfsPath}`);
  }

  // 1. For each chain, the Safe account must have approved the spending of an unlimited amount of PNK tokens to its MerkleRedeem contract.
  // This means, approve it 1 time for Mainnet, 1 time for Gnosis, 1 time for Arbitrum, and you're all set.
  console.log("Generating batched transactions...");
  const merkleDropABI = [
    "function seedAllocations(uint256 _period, bytes32 _merkleRoot, uint256 _totalAllocation) external",
  ];

  for (const sinfo of snapshotInfos) {
    const tx = await new Contract(sinfo.chain.merkleDropAddress, merkleDropABI).populateTransaction.seedAllocations(
      sinfo.period,
      sinfo.snapshot.merkleTree.root,
      sinfo.snapshot.droppedAmount
    );

    createNewBatch();
    addTransactionToBatch(tx);
    writeTransactionBatch({
      name: "Seed allocations",
      chainId: sinfo.chain.chainId,
      chainShortName: sinfo.chain.chainShortName,
      safeAddress: sinfo.chain.safeAddress,
      outputPath: `tx-batch-${sinfo.chain.chainShortName}-${formatDateMonth(startDate)}.json`,
    });
  }
};

main();
