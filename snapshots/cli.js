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
import fileToIpfs from "@kleros/file-to-ipfs";

dotenv.config();

dayjs.extend(utc);

const chains = [
  {
    chainId: 1,
    blocksPerSecond: 0.066667,
    klerosLiquidAddress: "0x988b3a538b618c7a603e1c11ab82cd16dbe28069",
    token: "0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d",
    pnkDropRatio: BigNumber.from("900000000"),
    fromBlock: 7300000,
    provider: getDefaultProvider(process.env.PNK_DROP_JSON_RPC_URL),
  },
  {
    chainId: 100,
    blocksPerSecond: 0.2,
    klerosLiquidAddress: "0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002",
    token: "0xcb3231aBA3b451343e0Fddfc45883c842f223846",
    pnkDropRatio: BigNumber.from("100000000"),
    fromBlock: 16895601,
    provider: getDefaultProvider("https://rpc.gnosischain.com"),
  },
];

const argv = yargs(hideBin(process.argv))
  .strict(true)
  .locale("en")
  .usage(`Usage: $0 --lastamount={n}`)
  .epilogue("Alternatively you can set the same params in the .env file. Check .env.example.")
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
  const baseYear = 2024;
  const baseMonth = 0; // January is 0 in Date.UTC
  const monthDiff = (currentYear - baseYear) * 12 + currentMonth - baseMonth - 1;

  // target starts at 29 for January 2024 and increases by 1 each period
  // maxes at 50
  const target = BigNumber.from(Math.min(29 + monthDiff, 50)).mul(BigNumber.from("10000000"));
  // mainnetPeriod starts at 35 for January 2024 and also increases by 1 each period
  // gnosisPeriod starts at 30 for January 2024 and increases by 1 each period
  // only used for _week argument in merkledrop.seedAllocations()
  const periods = { 1: 35 + monthDiff, 100: 30 + monthDiff };

  return { startDate, endDate, previousDate, target, periods };
};

const main = async () => {
  // get the utc dates of the period.
  const { startDate, endDate, previousDate, target, periods } = getDatesAndPeriod();

  // for each chain, count the "average" total pnk staked of the month.
  // to get this value, we can run the entire snapshot creator function,
  // create the entire merkle tree. not efficient but safer than modifying
  // working legacy.
  // getting this value implies getting it for all chains.
  const getTotalPNKStaked = async () => {
    let sum = BigNumber.from(0);
    for (const chain of chains) {
      console.log("Counting average PNK for chainId", chain.chainId);

      const createSnapshot = await createSnapshotCreator({
        provider: chain.provider,
        klerosLiquidAddress: chain.klerosLiquidAddress,
        droppedAmount: BigNumber.from(0), // we're not awarding anything, just counting.
      });

      const snapshot = await createSnapshot({
        fromBlock: chain.fromBlock,
        startDate: previousDate,
        endDate: startDate,
      });
      console.log(
        "[",
        chain.chainId,
        "] holds",
        BigNumber.from(snapshot.averageTotalStaked).div(BigNumber.from("1000000000000000000")).toString(),
        "PNK, that is,",
        BigNumber.from(snapshot.averageTotalStaked).div(BigNumber.from("1000000000000000000000000")).toString(),
        "millions"
      );
      sum = sum.add(snapshot.averageTotalStaked);
    }
    return sum;
  };
  const totalPNKStaked = await getTotalPNKStaked();

  // lets compute the formula to figure out how much will be awarded in total this month
  const pnkMainnet = new Contract(
    chains[0].token,
    ["function totalSupply() view returns (uint256)"],
    chains[0].provider
  );
  const totalSupply = await pnkMainnet.totalSupply();
  console.log(
    "Total PNK staked:",
    BigNumber.from(totalPNKStaked).div(BigNumber.from("1000000000000000000")).toString(),
    " PNK, that is,",
    BigNumber.from(totalPNKStaked).div(BigNumber.from("1000000000000000000000000")).toString(),
    "millions"
  );
  // basis points: 9 zeroes
  const basis = BigNumber.from(1000000000);
  const stakePercent = totalPNKStaked.mul(basis).div(totalSupply);
  const onePlusStakeMinusTarget = basis.add(target).sub(stakePercent);
  const fullReward = lastamount.mul(onePlusStakeMinusTarget).div(basis);

  console.log("Current percent staked, in ten thousand basis:", stakePercent.div(BigNumber.from(100000)).toString());
  console.log("Target is:", target.div(BigNumber.from(100000)).toString());
  console.log("Multiplier basis:", onePlusStakeMinusTarget.div(BigNumber.from(100000)).toString());

  console.log("FULL REWARD:", fullReward.toString(), "PNK (wei) will be rewarded");

  console.log("-----------");
  console.log("Generating Merkle Trees");
  console.log("-----------");

  const snapshotInfos = [];
  for (const c of chains) {
    const droppedAmount = fullReward.mul(c.pnkDropRatio).div(basis);
    console.log("> Chain [", c.chainId, "] ", droppedAmount.toString(), "PNK (wei) will be rewarded");
    const createSnapshot = await createSnapshotCreator({
      provider: c.provider,
      klerosLiquidAddress: c.klerosLiquidAddress,
      droppedAmount,
    });
    const snapshot = await createSnapshot({ fromBlock: c.fromBlock, startDate, endDate });
    snapshotInfos.push({
      // edit when arbitrum inclusion
      filename: `${c.chainId == "1" ? "" : "xdai-"}snapshot-${startDate.toISOString().slice(0, 7)}.json`,
      chain: c,
      snapshot,
      period: periods[c.chainId],
    });
  }

  // paste these into kleros/court
  for (const sinfo of snapshotInfos) {
    const path = `.cache/${sinfo.filename}`;
    fs.writeFileSync(path, JSON.stringify(sinfo.snapshot));
    const ipfsPath = await fileToIpfs(path);
    console.log(`https://ipfs.kleros.io${ipfsPath}`);
  }

  // txs to run sequentially, hardcoded section.
  //1. Approve `0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38` (mainnet) to spend 900k PNK  (token address `0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d`)
  // >>>> ignoring.
  //2. Seed week X on Mainnet.
  const merkleContractMainnet = new Contract("0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38", [
    "function seedAllocations(uint _week, bytes32 _merkleRoot, uint _totalAllocation) external",
  ]);
  const txToUrl = (tx, chainId) =>
    `https://greenlucid.github.io/lame-tx-prompt/site?to=${tx.to}&data=${tx.data}&value=0&chainId=${chainId}`;
  const tx1 = await merkleContractMainnet.populateTransaction.seedAllocations(
    snapshotInfos[0].period,
    snapshotInfos[0].snapshot.merkleTree.root,
    snapshotInfos[0].snapshot.droppedAmount
  );
  console.log("PNK should be already approved to Merkle Drop");
  console.log("1: ", txToUrl(tx1, 1));
  console.log(
    "2: ",
    "https://omni.gnosischain.com/bridge",
    " amount: ",
    formatEther(snapshotInfos[1].snapshot.droppedAmount)
  );
  console.log("3: http://court.kleros.io and xPNK -> stPNK");
  console.log("stPNK should be already approved to Merkle Drop");
  const merkleContractGnosis = new Contract("0xf1A9589880DbF393F32A5b2d5a0054Fa10385074", [
    "function seedAllocations(uint _week, bytes32 _merkleRoot, uint _totalAllocation) external",
  ]);
  const tx2 = await merkleContractGnosis.populateTransaction.seedAllocations(
    snapshotInfos[1].period,
    snapshotInfos[1].snapshot.merkleTree.root,
    snapshotInfos[1].snapshot.droppedAmount
  );
  console.log("4: ", txToUrl(tx2, 100));
};

main();
