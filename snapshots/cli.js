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
    provider: getDefaultProvider(process.env.INFURA_ETH_MAINNET_RPC),
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

// KIP-86: Kleros Cooperative addresses excluded from supply and rewards
// https://forum.kleros.io/t/kip-86-exclude-pnk-held-by-the-kleros-cooperative-from-kip-66/1423
const KIP_86_EXCLUDED_ADDRESSES = [
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

// KIP-86: PNK token addresses per chain (for balance queries)
const KIP_86_PNK_ADDRESSES = {
  1: "0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d",
  100: "0x37b60f4e9a31a64ccc0024dce7d0fd07eaa0f7b3",
  42161: "0x330bd769382cfc6d50175903434ccc8d206dcae5",
};

// KIP-86: LP pools where Cooperative holds PNK positions
// "v4": Uniswap V4 singleton PoolManager holds all V4 PNK. Coop dominates V4 PNK liquidity (~68M),
//        so PNK.balanceOf(PoolManager) is a close approximation of coop's V4 PNK.
// "v2": Standard V2/Swapr (DXswap) pair — calculate coop's exact proportional share from LP tokens.
const KIP_86_LP_POOLS = [
  { chainId: 1, type: "v4", address: "0x000000000004444c5dc75cB358380D2e3dE08A90", name: "Uniswap V4" },
  { chainId: 100, type: "v2", address: "0x2613cb099c12cecb1bd290fd0ef6833949374165", name: "Swapr" },
  { chainId: 42161, type: "v2", address: "0x540F6Ae41EA8e62b92F3Ab205ca13fee9290C678", name: "Uniswap V2" },
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
  const baseYear = 2025;
  const baseMonth = 8; // September is 8 in Date.UTC
  const monthDiff = (currentYear - baseYear) * 12 + currentMonth - baseMonth - 1;

  // target starts at 33 % for September 2025 and increases by 0.2 % each period, max 50 %
  const targetPercentage = Math.min(33 + 0.2 * monthDiff, 50); // % as float
  const target = BigNumber.from(Math.floor(targetPercentage * 1e7)); // scale to 1 e-7 units
  // mainnetPeriod starts at 55 for September 2025 and also increases by 1 each period
  // gnosisPeriod starts at 50 for September 2025 and increases by 1 each period
  // only used for _week argument in merkledrop.seedAllocations()
  const periods = { 1: 55 + monthDiff, 100: 50 + monthDiff };

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
        droppedAmount: BigNumber.from(0), // we're not awarding anything, just counting.
        excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
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
  const pnkMainnet = new Contract(
    chains[0].token,
    ["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"],
    chains[0].provider
  );
  const totalSupply = await pnkMainnet.totalSupply();
  const totalSupplyInPnk = parseFloat(formatEther(totalSupply));
  const totalSupplyDisplay =
    totalSupplyInPnk >= 1000000
      ? `${(totalSupplyInPnk / 1000000).toFixed(2)}M`
      : `${(totalSupplyInPnk / 1000).toFixed(0)}K`;
  console.log(`\n      *** TOTAL PNK SUPPLY: ${totalSupplyDisplay} PNK (${totalSupply} wei) ***\n`);

  // KIP-86: Dynamically exclude Cooperative PNK from supply (wallets + LP pools across all chains)
  console.log("      [KIP-86] Excluding Cooperative PNK from supply:");
  const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
  const V2_PAIR_ABI = [
    "function token0() view returns (address)",
    "function getReserves() view returns (uint112, uint112, uint32)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ];

  // Build provider map for all chains
  const kip86Providers = {
    1: chains[0].provider,
    100: chains[1].provider,
    42161: getDefaultProvider(process.env.INFURA_ARB_ONE_RPC),
  };

  // PNK token contracts per chain
  const pnkContracts = { 1: pnkMainnet };
  for (const chainId of [100, 42161]) {
    if (kip86Providers[chainId]) {
      pnkContracts[chainId] = new Contract(KIP_86_PNK_ADDRESSES[chainId], ERC20_BALANCE_ABI, kip86Providers[chainId]);
    }
  }

  // 1. Query wallet balances across all available chains in parallel
  const walletQueries = [];
  for (const [chainId, pnkContract] of Object.entries(pnkContracts)) {
    for (const addr of KIP_86_EXCLUDED_ADDRESSES) {
      walletQueries.push(
        pnkContract.balanceOf(addr).then((bal) => ({ chainId: Number(chainId), address: addr, balance: bal }))
      );
    }
  }

  // 2. Query LP pool PNK held by the Cooperative
  const lpQueries = KIP_86_LP_POOLS.filter((lp) => pnkContracts[lp.chainId]).map(async (lp) => {
    if (lp.type === "v4") {
      // V4 singleton PoolManager holds all V4 PNK. Coop dominates V4 PNK liquidity,
      // so total PNK in PoolManager ≈ coop's V4 PNK.
      const balance = await pnkContracts[lp.chainId].balanceOf(lp.address);
      return { ...lp, balance };
    }
    // V2/Swapr: calculate Cooperative's exact proportional PNK share from LP tokens
    const pair = new Contract(lp.address, V2_PAIR_ABI, kip86Providers[lp.chainId]);
    const [token0, reserves, supply, ...lpBalances] = await Promise.all([
      pair.token0(),
      pair.getReserves(),
      pair.totalSupply(),
      ...KIP_86_EXCLUDED_ADDRESSES.map((addr) => pair.balanceOf(addr)),
    ]);
    const pnkIsToken0 = token0.toLowerCase() === KIP_86_PNK_ADDRESSES[lp.chainId].toLowerCase();
    const pnkReserve = pnkIsToken0 ? reserves[0] : reserves[1];
    let coopLpTotal = BigNumber.from(0);
    for (const bal of lpBalances) {
      coopLpTotal = coopLpTotal.add(bal);
    }
    const balance = supply.isZero() ? BigNumber.from(0) : coopLpTotal.mul(pnkReserve).div(supply);
    return { ...lp, balance };
  });

  const [walletResults, lpResults] = await Promise.all([Promise.all(walletQueries), Promise.all(lpQueries)]);

  // Sum and log wallet balances
  let walletTotal = BigNumber.from(0);
  for (const { chainId, address, balance } of walletResults) {
    if (!balance.isZero()) {
      walletTotal = walletTotal.add(balance);
      const balInPnk = parseFloat(formatEther(balance));
      const balDisplay =
        balInPnk >= 1000000 ? `${(balInPnk / 1000000).toFixed(2)}M` : `${(balInPnk / 1000).toFixed(0)}K`;
      console.log(`        ${address} (chain ${chainId}): ${balDisplay} PNK`);
    }
  }
  const walletInPnk = parseFloat(formatEther(walletTotal));
  const walletDisplay =
    walletInPnk >= 1000000 ? `${(walletInPnk / 1000000).toFixed(2)}M` : `${(walletInPnk / 1000).toFixed(0)}K`;
  console.log(
    `        Wallets total (${KIP_86_EXCLUDED_ADDRESSES.length} addrs × ${
      Object.keys(pnkContracts).length
    } chains): ${walletDisplay} PNK`
  );

  // Sum and log LP PNK
  let lpTotal = BigNumber.from(0);
  for (const { chainId, name, type, balance } of lpResults) {
    if (!balance.isZero()) {
      lpTotal = lpTotal.add(balance);
      const lpInPnk = parseFloat(formatEther(balance));
      const lpDisplay = lpInPnk >= 1000000 ? `${(lpInPnk / 1000000).toFixed(2)}M` : `${(lpInPnk / 1000).toFixed(0)}K`;
      const note = type === "v4" ? " ~approx" : "";
      console.log(`        LP ${name} (chain ${chainId}): ${lpDisplay} PNK${note}`);
    }
  }

  const cooperativePNK = walletTotal.add(lpTotal);
  const coopInPnk = parseFloat(formatEther(cooperativePNK));
  const coopDisplay =
    coopInPnk >= 1000000 ? `${(coopInPnk / 1000000).toFixed(2)}M` : `${(coopInPnk / 1000).toFixed(0)}K`;
  console.log(`        Total excluded: ${coopDisplay} PNK`);
  const adjustedSupply = totalSupply.sub(cooperativePNK);
  const adjustedInPnk = parseFloat(formatEther(adjustedSupply));
  const adjustedDisplay =
    adjustedInPnk >= 1000000 ? `${(adjustedInPnk / 1000000).toFixed(2)}M` : `${(adjustedInPnk / 1000).toFixed(0)}K`;
  console.log(`      *** ADJUSTED SUPPLY (KIP-86): ${adjustedDisplay} PNK (${adjustedSupply} wei) ***\n`);

  const totalInPnk = parseFloat(formatEther(totalPNKStaked));
  const totalDisplay =
    totalInPnk >= 1000000 ? `${(totalInPnk / 1000000).toFixed(2)}M` : `${(totalInPnk / 1000).toFixed(0)}K`;
  console.log(`      Total: ${totalDisplay} PNK (${totalPNKStaked} wei) staked\n`);
  // basis points: 9 zeroes
  const basis = BigNumber.from(1000000000);
  const stakePercent = totalPNKStaked.mul(basis).div(adjustedSupply);
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
      droppedAmount,
      excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
    });
    const snapshot = await createSnapshot({ fromBlock: c.fromBlock, startDate, endDate });
    const stakedInPnk = parseFloat(formatEther(snapshot.averageTotalStaked));
    const stakedDisplay =
      stakedInPnk >= 1000000 ? `${(stakedInPnk / 1000000).toFixed(2)}M` : `${(stakedInPnk / 1000).toFixed(0)}K`;
    console.log(`      Chain ${c.chainId}: ${stakedDisplay} PNK (${snapshot.averageTotalStaked} wei) staked`);
    console.log(`        └─ Reward: ${droppedDisplay} PNK (${droppedAmount} wei)`);
    currentMonthTotalStaked = currentMonthTotalStaked.add(snapshot.averageTotalStaked);
    snapshotInfos.push({
      // edit when arbitrum inclusion
      filename: `${c.chainId == "1" ? "" : "xdai-"}snapshot-${startDate.toISOString().slice(0, 7)}.json`,
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

  // paste these into kleros/court
  console.log("\nIPFS URLs:");
  for (const sinfo of snapshotInfos) {
    const path = `.cache/${sinfo.filename}`;
    fs.writeFileSync(path, JSON.stringify(sinfo.snapshot));
    const ipfsPath = await fileToIpfs(path);
    console.log(`  https://cdn.kleros.link/ipfs/${ipfsPath}`);
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
  console.log("\nExecution Steps:");
  console.log("  [Pre-req] PNK should be already approved to Merkle Drop contract");
  console.log(`  [1] ${txToUrl(tx1, 1)}`);
  console.log(
    `  [2] https://bridge.gnosischain.com/ (amount: ${formatEther(snapshotInfos[1].snapshot.droppedAmount)})`
  );
  console.log("  [3] http://court.kleros.io and xPNK -> stPNK");
  console.log("  [Pre-req] stPNK should be already approved to Merkle Drop contract");
  const merkleContractGnosis = new Contract("0xf1A9589880DbF393F32A5b2d5a0054Fa10385074", [
    "function seedAllocations(uint _week, bytes32 _merkleRoot, uint _totalAllocation) external",
  ]);
  const tx2 = await merkleContractGnosis.populateTransaction.seedAllocations(
    snapshotInfos[1].period,
    snapshotInfos[1].snapshot.merkleTree.root,
    snapshotInfos[1].snapshot.droppedAmount
  );
  console.log(`  [4] ${txToUrl(tx2, 100)}\n`);
};

main();
