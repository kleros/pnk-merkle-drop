import { BigNumber } from "ethers";

// The chains the drop is distributed on. `pnkDropRatio` is each chain's share of the reward, in
// basis points of 9 zeroes (they must add up to 1000000000), and `merkleRedeem` is the contract the
// chain's drop is seeded into, which distributes `token`. `owner` is the account that owns it and
// seeds it: the printed signing commands sign from it, and cast refuses to sign as any other account.
// The providers are built from `rpcEnvVar` by cli.js.
export const CHAINS = [
  {
    chainId: 1,
    blocksPerSecond: 0.066667,
    klerosLiquidAddress: "0x988b3a538b618c7a603e1c11ab82cd16dbe28069",
    token: "0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d",
    merkleRedeem: "0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38",
    owner: "0x28A81EC3045F079DCf051BA2F3280335D18144cC",
    pnkDropRatio: BigNumber.from("900000000"),
    fromBlock: 7300000,
    rpcEnvVar: "ALCHEMY_ETH_MAINNET_RPC",
  },
  {
    chainId: 100,
    blocksPerSecond: 0.2,
    klerosLiquidAddress: "0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002",
    token: "0xcb3231aBA3b451343e0Fddfc45883c842f223846",
    merkleRedeem: "0xf1A9589880DbF393F32A5b2d5a0054Fa10385074",
    owner: "0x28A81EC3045F079DCf051BA2F3280335D18144cC",
    pnkDropRatio: BigNumber.from("100000000"),
    fromBlock: 16895601,
    rpcEnvVar: "ALCHEMY_GNOSIS_RPC",
  },
];

// KIP-86: Kleros Cooperative addresses excluded from supply and rewards
// https://forum.kleros.io/t/kip-86-exclude-pnk-held-by-the-kleros-cooperative-from-kip-66/1423
// Wallet balances can be manually cross-checked with DeBank bundle: https://debank.com/bundles/69929/accounts
// (LP/pool positions are queried on-chain separately — see KIP_86_LP_POOLS below)
// test/config.test.js pins this list to the KIP's text: changing it takes a KIP.
export const KIP_86_EXCLUDED_ADDRESSES = [
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
export const KIP_86_PNK_ADDRESSES = {
  1: "0x93ed3fbe21207ec2e8f2d3c3de6e058cb73bc04d",
  100: "0x37b60f4e9a31a64ccc0024dce7d0fd07eaa0f7b3",
  42161: "0x330bd769382cfc6d50175903434ccc8d206dcae5",
};

// KIP-86: Additional PNK-equivalent tokens per chain (e.g. stPNK on Gnosis = wrapped PNK for court staking)
export const KIP_86_ADDITIONAL_PNK_TOKENS = {
  100: ["0xcb3231aBA3b451343e0Fddfc45883c842f223846"], // stPNK
};

// KIP-86: LP pools where Cooperative holds PNK positions
// "uniswap-v4": Exact calculation — enumerates coop's Uniswap V4 position NFTs, reads tick ranges & liquidity,
//               and computes precise PNK amounts using TickMath + LiquidityAmounts (ported from Uniswap V4 core).
//               `address` is the chain's PoolManager, which holds the tokens of every V4 pool.
// "v2-pair":    Generic V2-style AMM pair (Uniswap V2, Swapr V2 / DXswap, etc.) — calculate coop's exact
//               proportional share from LP tokens.
export const KIP_86_LP_POOLS = [
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

// KIP-86: Uniswap V3 positions (same PM address on ETH + Arbitrum; not deployed on Gnosis)
export const V3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

// KIP-86: Sablier vesting streams where the Cooperative is the sender.
// Only the refundable (unvested + cancelable) portion is excluded — vested PNK belongs to the recipient.
// Dynamically scans ALL streams on configured contracts for coop senders — no hardcoded stream IDs.
// Each chain lists every Lockup release the Cooperative has streamed PNK from, plus the current one the Sablier
// app creates new streams on. A contract holding no PNK costs one balance check and is skipped.
export const KIP_86_SABLIER = {
  1: {
    contracts: [
      "0x93b37bd5b6b278373217333ac30d7e74c85fbdcb", // SablierLockup v4.0 (LK3)
    ],
  },
  42161: {
    contracts: [
      "0x467d5bf8cfa1a5f99328fbdcb9c751c78934b725", // SablierLockup v2.0 (LK)
      "0x53F5eEB133B99C6e59108F35bCC7a116da50c5ce", // SablierV2LockupDynamic v1.2 (LD3)
      "0x05a323a4c936fed6d02134c5f0877215cd186b51", // SablierV2LockupLinear v1.2 (LL3)
      "0xf12abfb041b5064b839ca56638cdb62fea712db5", // SablierLockup v3.0 (LK2)
      "0x0dA2c7Aa93E7CD43e6b8D043Aab5b85CfDDf3818", // SablierV2LockupTranched v1.2 (LT3)
      "0xD103611856F3c2BbAe61D9bF138078794fC09C33", // SablierLockup v4.0 (LK3)
    ],
  },
};

// KIP-86: LlamaPay vesting escrows (a fork of Yearn's yearn-vesting-escrow) that the Cooperative funded and owns.
// As with Sablier, only the unvested part the owner can still revoke is excluded — vested PNK belongs to the recipient.
// Escrows are discovered from each factory's creation events, scanned from the block the factory was deployed at.
// Gnosis is left out: the Cooperative has no escrows there, and Alchemy caps Gnosis log queries at 10,000 blocks.
export const KIP_86_VESTING_ESCROWS = {
  1: { factory: "0xcf61782465ff973638143d6492b51a85986ab347", fromBlock: 19739664 }, // LlamaPay Vesting v2
  42161: { factory: "0x62e13be78af77c86d38a027ae432f67d9ecd4c10", fromBlock: 205098780 }, // LlamaPay Vesting v2
};
