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
import { getCoopV4Pnk } from "./src/helpers/uniswap-v4-positions.js";
import { getCoopV3Pnk } from "./src/helpers/uniswap-v3-positions.js";
import { getCoopSablierPnk } from "./src/helpers/sablier-streams.js";
import { getCoopFutarchyPnk } from "./src/helpers/futarchy-positions.js";

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
    provider: getDefaultProvider(process.env.ALCHEMY_ETH_MAINNET_RPC),
  },
  {
    chainId: 100,
    blocksPerSecond: 0.2,
    klerosLiquidAddress: "0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002",
    token: "0xcb3231aBA3b451343e0Fddfc45883c842f223846",
    pnkDropRatio: BigNumber.from("100000000"),
    fromBlock: 16895601,
    provider: getDefaultProvider(process.env.ALCHEMY_GNOSIS_RPC),
  },
];

// KIP-86: Kleros Cooperative addresses excluded from supply and rewards
// https://forum.kleros.io/t/kip-86-exclude-pnk-held-by-the-kleros-cooperative-from-kip-66/1423
// Wallet balances can be manually cross-checked with DeBank bundle: https://debank.com/bundles/69929/accounts
// (LP/pool positions are queried on-chain separately — see KIP_86_LP_POOLS below)
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

// KIP-86: Additional PNK-equivalent tokens per chain (e.g. stPNK on Gnosis = wrapped PNK for court staking)
const KIP_86_ADDITIONAL_PNK_TOKENS = {
  100: ["0xcb3231aBA3b451343e0Fddfc45883c842f223846"], // stPNK
};

// KIP-86: LP pools where Cooperative holds PNK positions
// "uniswap-v4": Exact calculation — enumerates coop's Uniswap V4 position NFTs, reads tick ranges & liquidity,
//               and computes precise PNK amounts using TickMath + LiquidityAmounts (ported from Uniswap V4 core).
// "v2-pair":    Generic V2-style AMM pair (Uniswap V2, Swapr V2 / DXswap, etc.) — calculate coop's exact
//               proportional share from LP tokens.
const KIP_86_LP_POOLS = [
  {
    chainId: 1,
    type: "uniswap-v4",
    address: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    name: "Uniswap V4",
  },
  {
    chainId: 42161,
    type: "uniswap-v4",
    address: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    positionManager: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869",
    stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
    name: "Uniswap V4",
  },
  { chainId: 100, type: "v2-pair", address: "0x2613cb099c12cecb1bd290fd0ef6833949374165", name: "Swapr V2" },
  { chainId: 42161, type: "v2-pair", address: "0x540F6Ae41EA8e62b92F3Ab205ca13fee9290C678", name: "Uniswap V2" },
];

// KIP-86: Sablier vesting streams where the Cooperative is the sender.
// Only the refundable (unvested + cancelable) portion is excluded — vested PNK belongs to the recipient.
// Dynamically scans ALL streams on configured contracts for coop senders — no hardcoded stream IDs.
const KIP_86_SABLIER = {
  42161: {
    contracts: [
      "0x467d5bf8cfa1a5f99328fbdcb9c751c78934b725", // SablierLockup V4
      "0x53F5eEB133B99C6e59108F35bCC7a116da50c5ce", // SablierV2LockupDynamic
    ],
  },
};

// KIP-86: Futarchy/Seer conditional token markets where the Cooperative holds YES_PNK / NO_PNK.
// Dynamically discovers all YES_PNK / NO_PNK tokens via the Blockscout API (no event scanning needed),
// then checks Algebra LP positions for additional amounts.
// Redeemable PNK per market = min(total_YES_PNK, total_NO_PNK) — coop can merge back to PNK at any time.
// No hardcoded market addresses — new Futarchy markets are discovered automatically.
const KIP_86_FUTARCHY = {
  100: {
    blockscoutApi: "https://gnosis.blockscout.com",
    ctf: "0xceafdd6bc0bef976fdcd1112955828e00543c0ce",
    algebraPM: "0x91fd594c46d8b01e62dbdebed2401dde01817834",
  },
};

// Retry an async function up to `maxRetries` times with exponential backoff.
// Ensures transient RPC failures don't crash the script, but persistent failures still throw.
const retry = async (fn, maxRetries = 3) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
};

// Format a PNK wei amount to a human-readable string (e.g. "96.77M PNK" or "58K PNK")
const displayPnk = (wei) => {
  const n = parseFloat(formatEther(wei));
  return n >= 1000000 ? `${(n / 1000000).toFixed(2)}M` : `${(n / 1000).toFixed(0)}K`;
};

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
      console.log(
        `      Chain ${chain.chainId}: ${displayPnk(snapshot.averageTotalStaked)} PNK (${
          snapshot.averageTotalStaked
        } wei) staked`
      );
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
  console.log(`\n      *** TOTAL PNK SUPPLY: ${displayPnk(totalSupply)} PNK (${totalSupply} wei) ***\n`);

  // KIP-86: Dynamically exclude Cooperative PNK from supply (wallets + LP pools across all chains)
  console.log("      [KIP-86] Excluding Cooperative PNK from supply:");
  const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
  const AMM_V2_PAIR_ABI = [
    "function token0() view returns (address)",
    "function getReserves() view returns (uint112, uint112, uint32)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ];

  // Build provider map for all chains
  const kip86Providers = {
    1: chains[0].provider,
    100: chains[1].provider,
    42161: getDefaultProvider(process.env.ALCHEMY_ARB_ONE_RPC),
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
        retry(() => pnkContract.balanceOf(addr)).then((bal) => ({
          chainId: Number(chainId),
          address: addr,
          balance: bal,
        }))
      );
    }
    // Also check additional PNK-equivalent tokens (e.g. stPNK on Gnosis)
    for (const tokenAddr of KIP_86_ADDITIONAL_PNK_TOKENS[Number(chainId)] || []) {
      const token = new Contract(tokenAddr, ERC20_BALANCE_ABI, kip86Providers[Number(chainId)]);
      for (const addr of KIP_86_EXCLUDED_ADDRESSES) {
        walletQueries.push(
          retry(() => token.balanceOf(addr)).then((bal) => ({
            chainId: Number(chainId),
            address: addr,
            balance: bal,
          }))
        );
      }
    }
  }

  // 2. Query LP pool PNK held by the Cooperative
  const lpQueries = KIP_86_LP_POOLS.filter((lp) => pnkContracts[lp.chainId]).map(async (lp) => {
    if (lp.type === "uniswap-v4") {
      const result = await getCoopV4Pnk({
        provider: kip86Providers[lp.chainId],
        positionManager: lp.positionManager,
        stateView: lp.stateView,
        pnkAddress: KIP_86_PNK_ADDRESSES[lp.chainId],
        excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
      });
      return { ...lp, balance: result.balance, details: result.details };
    }
    // V2-style AMM pair: calculate Cooperative's exact proportional PNK share from LP tokens
    const pair = new Contract(lp.address, AMM_V2_PAIR_ABI, kip86Providers[lp.chainId]);
    const [token0, reserves, supply, ...lpBalances] = await Promise.all([
      pair.token0(),
      pair.getReserves(),
      pair.totalSupply(),
      ...KIP_86_EXCLUDED_ADDRESSES.map((addr) => pair.balanceOf(addr)),
    ]);
    const pnkIsToken0 = token0.toLowerCase() === KIP_86_PNK_ADDRESSES[lp.chainId].toLowerCase();
    const pnkReserve = pnkIsToken0 ? reserves[0] : reserves[1];
    let coopLpTotal = BigNumber.from(0);
    const details = [];
    for (let i = 0; i < lpBalances.length; i++) {
      if (!lpBalances[i].isZero()) {
        const addrPnk = lpBalances[i].mul(pnkReserve).div(supply);
        details.push({ address: KIP_86_EXCLUDED_ADDRESSES[i], pnk: addrPnk });
        coopLpTotal = coopLpTotal.add(lpBalances[i]);
      }
    }
    const balance = supply.isZero() ? BigNumber.from(0) : coopLpTotal.mul(pnkReserve).div(supply);
    return { ...lp, balance, details };
  });

  // 3. Query Uniswap V3 positions (same PM address on ETH + Arbitrum; not deployed on Gnosis)
  const V3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
  const uniswapV3Queries = [1, 42161]
    .filter((chainId) => kip86Providers[chainId])
    .map((chainId) =>
      getCoopV3Pnk({
        provider: kip86Providers[chainId],
        positionManager: V3_POSITION_MANAGER,
        pnkAddress: KIP_86_PNK_ADDRESSES[chainId],
        excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
      }).then((result) => ({ chainId, name: "Uniswap V3", ...result }))
    );

  // 4. Query Sablier vesting streams (refundable/unvested PNK the coop can recover)
  const sablierQueries = Object.entries(KIP_86_SABLIER)
    .filter(([chainId]) => kip86Providers[Number(chainId)])
    .map(([chainId, config]) =>
      getCoopSablierPnk({
        provider: kip86Providers[Number(chainId)],
        sablierContracts: config.contracts,
        pnkAddress: KIP_86_PNK_ADDRESSES[Number(chainId)],
        excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
      }).then((result) => ({ chainId: Number(chainId), name: "Sablier", ...result }))
    );

  // 5. Query Futarchy conditional token markets (YES_PNK / NO_PNK → redeemable PNK)
  const futarchyQueries = Object.entries(KIP_86_FUTARCHY)
    .filter(([chainId]) => kip86Providers[Number(chainId)])
    .map(([chainId, config]) =>
      getCoopFutarchyPnk({
        provider: kip86Providers[Number(chainId)],
        blockscoutApi: config.blockscoutApi,
        ctfAddress: config.ctf,
        pnkAddress: KIP_86_PNK_ADDRESSES[Number(chainId)],
        algebraPM: config.algebraPM,
        excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
      }).then((result) => ({ chainId: Number(chainId), name: "Futarchy", ...result }))
    );

  const withTiming = (label, promise) =>
    promise.then((r) => {
      console.log(`        [${label} done]`);
      return r;
    });

  const [walletResults, lpResults, uniswapV3Results, sablierResults, futarchyResults] = await Promise.all([
    withTiming("Wallets", Promise.all(walletQueries)),
    withTiming("LPs", Promise.all(lpQueries)),
    withTiming("V3", Promise.all(uniswapV3Queries)),
    withTiming("Sablier", Promise.all(sablierQueries)),
    withTiming("Futarchy", Promise.all(futarchyQueries)),
  ]);

  // Sum and log wallet balances
  let walletTotal = BigNumber.from(0);
  for (const { chainId, address, balance } of walletResults) {
    if (!balance.isZero()) {
      walletTotal = walletTotal.add(balance);
      console.log(`        ${address} (chain ${chainId}): ${displayPnk(balance)} PNK`);
    }
  }
  console.log(
    `        Wallets total (${KIP_86_EXCLUDED_ADDRESSES.length} addrs × ${
      Object.keys(pnkContracts).length
    } chains): ${displayPnk(walletTotal)} PNK`
  );

  // Sum and log LP PNK
  let lpTotal = BigNumber.from(0);
  for (const { chainId, name, balance, details } of lpResults) {
    if (!balance.isZero()) {
      lpTotal = lpTotal.add(balance);
      console.log(`        LP ${name} (chain ${chainId}): ${displayPnk(balance)} PNK`);
      if (details) {
        for (const d of details) {
          console.log(`          └─ ${d.address}: ${displayPnk(d.pnk)} PNK`);
        }
      }
    }
  }

  // Sum and log Uniswap V3 PNK
  let uniswapV3Total = BigNumber.from(0);
  for (const { chainId, name, balance, details } of uniswapV3Results) {
    if (!balance.isZero()) {
      uniswapV3Total = uniswapV3Total.add(balance);
      console.log(`        LP ${name} (chain ${chainId}): ${displayPnk(balance)} PNK`);
      if (details) {
        for (const d of details) {
          console.log(`          └─ ${d.address}: ${displayPnk(d.pnk)} PNK`);
        }
      }
    }
  }

  // Sum and log Sablier refundable PNK
  let sablierTotal = BigNumber.from(0);
  for (const { chainId, name, balance, details } of sablierResults) {
    if (!balance.isZero()) {
      sablierTotal = sablierTotal.add(balance);
      console.log(`        ${name} (chain ${chainId}): ${displayPnk(balance)} PNK (refundable/unvested)`);
      if (details) {
        for (const d of details) {
          console.log(`          └─ stream #${d.streamId} (sender: ${d.sender}): ${displayPnk(d.pnk)} PNK`);
        }
      }
    }
  }

  // Sum and log Futarchy redeemable PNK
  let futarchyTotal = BigNumber.from(0);
  for (const { chainId, name, balance, details, warnings } of futarchyResults) {
    if (!balance.isZero()) {
      futarchyTotal = futarchyTotal.add(balance);
      console.log(`        ${name} (chain ${chainId}): ${displayPnk(balance)} PNK (redeemable conditional tokens)`);
      if (details) {
        for (const d of details) {
          console.log(`          └─ market ${d.market} (YES: ${d.yes} / NO: ${d.no})`);
          console.log(`             ${displayPnk(d.redeemable)} PNK from ${d.holders.join(", ")}`);
        }
      }
    }
    if (warnings) {
      for (const w of warnings) {
        console.log(`        ⚠ ${w}`);
      }
    }
  }

  const cooperativePNK = walletTotal.add(lpTotal).add(uniswapV3Total).add(sablierTotal).add(futarchyTotal);
  console.log(`        Total excluded: ${displayPnk(cooperativePNK)} PNK`);
  console.log(
    "        ⚠ OPERATOR: manually verify this total against DeBank → https://debank.com/bundles/69929/portfolio"
  );
  const adjustedSupply = totalSupply.sub(cooperativePNK);
  console.log(`      *** ADJUSTED SUPPLY (KIP-86): ${displayPnk(adjustedSupply)} PNK (${adjustedSupply} wei) ***\n`);

  console.log(`      Total: ${displayPnk(totalPNKStaked)} PNK (${totalPNKStaked} wei) staked\n`);
  // basis points: 9 zeroes
  const basis = BigNumber.from(1000000000);
  const stakePercent = totalPNKStaked.mul(basis).div(adjustedSupply);
  const onePlusStakeMinusTarget = basis.add(target).sub(stakePercent);
  const fullReward = lastamount.mul(onePlusStakeMinusTarget).div(basis);

  console.log("[2/3] Calculating reward amount\n");
  const stakePercentDisplay = (stakePercent.div(BigNumber.from(100000)).toNumber() / 100).toFixed(2);
  const targetDisplay = (target.div(BigNumber.from(100000)).toNumber() / 100).toFixed(2);
  const multiplierDisplay = (onePlusStakeMinusTarget.toNumber() / 10000000).toFixed(2);
  console.log(`      Stake %: ${stakePercentDisplay}%`);
  console.log(`      Target %: ${targetDisplay}%`);
  console.log(`      Multiplier: ${multiplierDisplay}%`);
  console.log(
    `      Total Reward for ${startDate.toISOString().slice(0, 7)}: ${fullReward.toString()} wei (~${displayPnk(
      fullReward
    )} PNK)\n`
  );

  console.log(
    `[3/3] Generating snapshots for ${startDate.toISOString().slice(0, 7)} → ${endDate.toISOString().slice(0, 7)}\n`
  );

  const snapshotInfos = [];
  let currentMonthTotalStaked = BigNumber.from(0);
  for (const c of chains) {
    const droppedAmount = fullReward.mul(c.pnkDropRatio).div(basis);
    const droppedDisplay = displayPnk(droppedAmount);
    const createSnapshot = await createSnapshotCreator({
      provider: c.provider,
      klerosLiquidAddress: c.klerosLiquidAddress,
      droppedAmount,
      excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
    });
    const snapshot = await createSnapshot({ fromBlock: c.fromBlock, startDate, endDate });
    console.log(
      `      Chain ${c.chainId}: ${displayPnk(snapshot.averageTotalStaked)} PNK (${
        snapshot.averageTotalStaked
      } wei) staked`
    );
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
  console.log(`      Total Staked: ${displayPnk(currentMonthTotalStaked)} PNK (${currentMonthTotalStaked} wei)\n`);
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
