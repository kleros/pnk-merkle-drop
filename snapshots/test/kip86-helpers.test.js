import assert from "assert/strict";
import { describe, it } from "node:test";
import { BigNumber, constants, utils } from "ethers";
import { getCoopV2PairPnk } from "../src/helpers/amm-v2-pair-positions.js";
import { getCoopSablierPnk } from "../src/helpers/sablier-streams.js";
import { getAmountsForLiquidity } from "../src/helpers/uniswap-math.js";
import { getCoopV3Pnk } from "../src/helpers/uniswap-v3-positions.js";
import { getCoopV4Pnk } from "../src/helpers/uniswap-v4-positions.js";
import { getCoopVestingEscrowPnk } from "../src/helpers/vesting-escrows.js";
import { getCoopWalletBalances } from "../src/helpers/wallet-balances.js";
import { FakeChain, Revert, RpcFailure, withoutRetryDelays } from "./support/fake-chain.js";

/*
 * The KIP-86 helpers against fake contracts. Every fake answers only at the pinned block, so a helper
 * reading the chain head instead (which makes a period irreproducible) fails these tests.
 */

const wei = (value) => BigNumber.from(value);
const address = (n) => utils.getAddress(utils.hexZeroPad(utils.hexlify(n), 20));

const COOP = ["0x86ead908fb5d6f900ff109c9e26f79300f99271a", "0xdc657fac185d00cdfa34a8378bb87d586bf998f7"];
const OUTSIDER = address(0xbeef);
const PNK = address(0x1001);
const OTHER_TOKEN = address(0x1002);
const BLOCK = 500;

const pinned = (fn) => (args, context) => {
  if (context.blockTag !== BLOCK) throw new Error(`read at block ${context.blockTag}, not at the pinned ${BLOCK}`);
  return fn(args, context);
};
const lookup = (table, key) => table[key.toLowerCase()] ?? 0;
const byAddress = (entries) => Object.fromEntries(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));

const erc20 = (chain, token, balances) =>
  chain.contract(token, ["function balanceOf(address) view returns (uint256)"], {
    balanceOf: pinned(([who]) => lookup(byAddress(balances), who)),
  });

const total = ({ balance }) => balance.toString();

describe("wallet balances", () => {
  it("reads the PNK and PNK-equivalent tokens of every KIP-86 address, on every chain", async () => {
    const ethereum = new FakeChain({ chainId: 1 });
    const gnosis = new FakeChain({ chainId: 100 });
    const stPNK = address(0x1003);
    erc20(ethereum, PNK, { [COOP[0]]: 5, [COOP[1]]: 7, [OUTSIDER]: 1000 });
    erc20(gnosis, PNK, { [COOP[0]]: 11 });
    erc20(gnosis, stPNK, { [COOP[1]]: 13 });
    const results = await getCoopWalletBalances({
      providers: { 1: ethereum, 100: gnosis },
      pnkAddresses: { 1: PNK, 100: PNK },
      additionalPnkTokens: { 100: [stPNK] },
      excludedAddresses: COOP,
      blockTags: { 1: BLOCK, 100: BLOCK },
    });
    const byChain = (chainId) =>
      results.filter((r) => r.chainId === chainId).reduce((sum, r) => sum + r.balance.toNumber(), 0);
    assert.equal(byChain(1), 12);
    assert.equal(byChain(100), 24);
  });

  it("refuses to read a chain it has no pinned block for", async () => {
    const chain = new FakeChain();
    erc20(chain, PNK, {});
    await assert.rejects(
      getCoopWalletBalances({
        providers: { 1: chain, 100: chain },
        pnkAddresses: { 1: PNK, 100: PNK },
        additionalPnkTokens: {},
        excludedAddresses: COOP,
        blockTags: { 1: BLOCK },
      }),
      /No block to read chain 100 at/
    );
  });
});

describe("V2-style pairs", () => {
  const PAIR = address(0x2222);
  const pair = ({ token0, token1, reserves, supply, lp = {} }) => {
    const chain = new FakeChain();
    chain.contract(
      PAIR,
      [
        "function token0() view returns (address)",
        "function token1() view returns (address)",
        "function getReserves() view returns (uint112, uint112, uint32)",
        "function totalSupply() view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
      ],
      {
        token0: pinned(() => token0),
        token1: pinned(() => token1),
        getReserves: pinned(() => [reserves[0], reserves[1], 0]),
        totalSupply: pinned(() => supply),
        balanceOf: pinned(([who]) => lookup(byAddress(lp), who)),
      }
    );
    return getCoopV2PairPnk({
      provider: chain,
      pairAddress: PAIR,
      pnkAddress: PNK.toLowerCase(),
      excludedAddresses: COOP,
      blockTag: BLOCK,
    });
  };

  it("counts the Cooperative's share of the PNK reserve, on either side of the pair", async () => {
    const lp = { [COOP[0]]: 10, [COOP[1]]: 30, [OUTSIDER]: 60 };
    assert.equal(total(await pair({ token0: PNK, token1: OTHER_TOKEN, reserves: [1000, 7], supply: 100, lp })), "400");
    assert.equal(total(await pair({ token0: OTHER_TOKEN, token1: PNK, reserves: [7, 1000], supply: 100, lp })), "400");
  });

  it("counts nothing in a pair with no liquidity", async () => {
    assert.equal(total(await pair({ token0: PNK, token1: OTHER_TOKEN, reserves: [0, 0], supply: 0 })), "0");
  });

  it("stops on a pair that doesn't trade PNK", async () => {
    const lp = { [COOP[0]]: 10 };
    await assert.rejects(
      pair({ token0: OTHER_TOKEN, token1: address(0x1004), reserves: [1000, 7], supply: 100, lp }),
      /neither of which is PNK/
    );
  });
});

describe("Uniswap V4 positions", () => {
  const POSITION_MANAGER = address(0x4444);
  const STATE_VIEW = address(0x4445);
  const POOL_MANAGER = address(0x4446);
  const WETH = address(0x2000);
  const SQRT_PRICE_AT_TICK_0 = wei(2).pow(96);
  const PM_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)",
    "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  ];
  const poolKey = (currency0, currency1) => ({
    currency0,
    currency1,
    fee: 3000,
    tickSpacing: 60,
    hooks: constants.AddressZero,
  });
  // PositionInfo packs tickLower at bits 8-31 and tickUpper at bits 32-55, as two's complement int24s
  const positionInfo = (tickLower, tickUpper) =>
    wei(((BigInt.asUintN(24, BigInt(tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(tickLower)) << 8n)).toString());
  const pnkIn = ({ key, tickLower, tickUpper, liquidity }) => {
    const { amount0, amount1 } = getAmountsForLiquidity(SQRT_PRICE_AT_TICK_0, tickLower, tickUpper, liquidity);
    return BigInt(key.currency0 === PNK ? amount0 : amount1);
  };

  /*
   * positions: tokenId → { key, tickLower, tickUpper, liquidity }
   * transfers: [from, to, tokenId, blockNumber] in chain order
   * owned: address → how many positions balanceOf reports at the pinned block
   */
  const v4 = ({ positions, transfers, owned, poolManagerPnk = wei(10).pow(30) }) => {
    const chain = new FakeChain();
    const pm = chain.contract(POSITION_MANAGER, PM_ABI, {
      balanceOf: pinned(([who]) => lookup(byAddress(owned), who)),
      getPoolAndPositionInfo: pinned(([tokenId]) => {
        const { key, tickLower, tickUpper } = positions[tokenId.toNumber()];
        return [key, positionInfo(tickLower, tickUpper)];
      }),
      getPositionLiquidity: pinned(([tokenId]) => positions[tokenId.toNumber()].liquidity),
    });
    transfers.forEach(([from, to, tokenId, blockNumber], logIndex) =>
      pm.emit("Transfer", [from, to, tokenId], { blockNumber, logIndex })
    );
    chain.contract(
      STATE_VIEW,
      [
        "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
      ],
      { getSlot0: pinned(() => [SQRT_PRICE_AT_TICK_0, 0, 0, 3000]) }
    );
    erc20(chain, PNK, { [POOL_MANAGER]: poolManagerPnk });
    return getCoopV4Pnk({
      provider: chain,
      positionManager: POSITION_MANAGER,
      stateView: STATE_VIEW,
      poolManager: POOL_MANAGER,
      pnkAddress: PNK.toLowerCase(),
      excludedAddresses: COOP,
      blockTag: BLOCK,
    });
  };

  const fullRange = { key: poolKey(PNK, WETH), tickLower: -887220, tickUpper: 887220, liquidity: 10n ** 21n };
  const pnkAsCurrency1 = { key: poolKey(address(0x0500), PNK), tickLower: -600, tickUpper: -60, liquidity: 10n ** 20n };
  const notPnk = { key: poolKey(address(0x0500), WETH), tickLower: -60, tickUpper: 60, liquidity: 10n ** 22n };
  const mint = (to, tokenId, blockNumber) => [constants.AddressZero, to, tokenId, blockNumber];

  it("counts the PNK of the Cooperative's PNK positions, wherever PNK sits in the pool", async () => {
    const result = await v4({
      positions: { 1: fullRange, 2: notPnk, 3: pnkAsCurrency1 },
      transfers: [mint(COOP[0], 1, 10), mint(COOP[0], 2, 11), mint(COOP[1], 3, 12), mint(OUTSIDER, 4, 13)],
      owned: { [COOP[0]]: 2, [COOP[1]]: 1 },
    });
    assert.ok(pnkIn(fullRange) > 0n && pnkIn(pnkAsCurrency1) > 0n);
    assert.equal(total(result), (pnkIn(fullRange) + pnkIn(pnkAsCurrency1)).toString());
  });

  it("follows positions through their transfers: gone, back, or sent to the address itself", async () => {
    const result = await v4({
      positions: { 1: fullRange, 3: pnkAsCurrency1, 5: fullRange },
      transfers: [
        mint(COOP[0], 1, 10),
        mint(COOP[0], 5, 15),
        [COOP[0], OUTSIDER, 1, 20],
        [COOP[0], OUTSIDER, 5, 25],
        [OUTSIDER, COOP[0], 1, 30],
        mint(COOP[1], 3, 40),
        [COOP[1], COOP[1], 3, 50],
      ],
      owned: { [COOP[0]]: 1, [COOP[1]]: 1 },
    });
    assert.equal(total(result), (pnkIn(fullRange) + pnkIn(pnkAsCurrency1)).toString());
  });

  it("counts what was held at the pinned block, not later", async () => {
    const result = await v4({
      positions: { 1: fullRange },
      transfers: [mint(COOP[0], 1, 10), [COOP[0], OUTSIDER, 1, BLOCK + 1]],
      owned: { [COOP[0]]: 1 },
    });
    assert.equal(total(result), pnkIn(fullRange).toString());
  });

  it("skips positions without liquidity", async () => {
    const result = await v4({
      positions: { 1: { ...fullRange, liquidity: 0n } },
      transfers: [mint(COOP[0], 1, 10)],
      owned: { [COOP[0]]: 1 },
    });
    assert.equal(total(result), "0");
  });

  it("stops when the Transfer events miss a position the address holds", async () => {
    await assert.rejects(
      v4({ positions: { 1: fullRange }, transfers: [mint(COOP[0], 1, 10)], owned: { [COOP[0]]: 2 } }),
      /V4 NFT mismatch/
    );
  });

  it("stops when the positions add up to more PNK than the PoolManager holds", async () => {
    await assert.rejects(
      v4({
        positions: { 1: fullRange },
        transfers: [mint(COOP[0], 1, 10)],
        owned: { [COOP[0]]: 1 },
        poolManagerPnk: wei((pnkIn(fullRange) - 1n).toString()),
      }),
      /more than the .* the PoolManager/
    );
  });
});

describe("Uniswap V3 positions", () => {
  const POSITION_MANAGER = address(0x3333);
  const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
  const POOL = address(0x3334);
  const WETH = address(0x2000);
  const SQRT_PRICE = wei(2).pow(96);

  it("counts the PNK of the Cooperative's positions with liquidity", async () => {
    const chain = new FakeChain();
    const positions = {
      1: { owner: COOP[0], token0: PNK, token1: WETH, tickLower: -600, tickUpper: 600, liquidity: 10n ** 21n },
      2: { owner: COOP[0], token0: PNK, token1: WETH, tickLower: -600, tickUpper: 600, liquidity: 0n },
      3: { owner: COOP[1], token0: OTHER_TOKEN, token1: WETH, tickLower: -60, tickUpper: 60, liquidity: 10n ** 21n },
    };
    const ownedBy = (who) => Object.keys(positions).filter((id) => positions[id].owner === who.toLowerCase());
    chain.contract(
      POSITION_MANAGER,
      [
        "function balanceOf(address) view returns (uint256)",
        "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
        "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
      ],
      {
        balanceOf: pinned(([who]) => ownedBy(who).length),
        tokenOfOwnerByIndex: pinned(([who, index]) => ownedBy(who)[index.toNumber()]),
        positions: pinned(([tokenId]) => {
          const { token0, token1, tickLower, tickUpper, liquidity } = positions[tokenId.toNumber()];
          return [
            0,
            constants.AddressZero,
            token0,
            token1,
            3000,
            tickLower,
            tickUpper,
            liquidity.toString(),
            0,
            0,
            0,
            0,
          ];
        }),
      }
    );
    chain.contract(FACTORY, ["function getPool(address, address, uint24) view returns (address)"], {
      getPool: pinned(() => POOL),
    });
    chain.contract(
      POOL,
      [
        "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
      ],
      { slot0: pinned(() => [SQRT_PRICE, 0, 0, 0, 0, 0, true]) }
    );
    const result = await getCoopV3Pnk({
      provider: chain,
      positionManager: POSITION_MANAGER,
      pnkAddress: PNK.toLowerCase(),
      excludedAddresses: COOP,
      blockTag: BLOCK,
    });
    const { amount0 } = getAmountsForLiquidity(SQRT_PRICE, -600, 600, 10n ** 21n);
    assert.ok(amount0 > 0n);
    assert.equal(total(result), amount0.toString());
  });
});

describe("Sablier streams", () => {
  const SABLIER_ABI = [
    "function getSender(uint256) view returns (address)",
    "function getAsset(uint256) view returns (address)",
    "function getUnderlyingToken(uint256) view returns (address)",
    "function refundableAmountOf(uint256) view returns (uint128)",
    "function nextStreamId() view returns (uint256)",
    "function getLockupModel(uint256) view returns (uint8)",
  ];
  const PRICE_GATED = 3;
  const LOCKUP_V1 = address(0x5551);
  const LOCKUP_V2 = address(0x5552);

  /*
   * Lockup v1.x names a stream's token getAsset and has no getLockupModel; v2.0+ names it
   * getUnderlyingToken. Each stream: { sender, token, refundable, model }, where `refundable` may be a
   * function that throws, to make that read revert or fail.
   */
  const lockup = (chain, at, { version, streams, nextStreamId = Object.keys(streams).length + 1 }) => {
    const stream = (id) => streams[id.toNumber()];
    const functions = {
      nextStreamId: pinned(() => nextStreamId),
      getSender: pinned(([id]) => stream(id).sender),
      refundableAmountOf: pinned(([id]) => {
        const { refundable } = stream(id);
        return typeof refundable === "function" ? refundable() : refundable;
      }),
    };
    if (version === 1) {
      functions.getAsset = pinned(([id]) => stream(id).token);
    } else {
      functions.getUnderlyingToken = pinned(([id]) => stream(id).token);
      functions.getLockupModel = pinned(([id]) => stream(id).model ?? 0);
    }
    chain.contract(at, SABLIER_ABI, functions);
  };
  const scan = (chain, contracts) =>
    getCoopSablierPnk({
      provider: chain,
      sablierContracts: contracts,
      pnkAddress: PNK.toLowerCase(),
      excludedAddresses: COOP,
      blockTag: BLOCK,
    });
  const quietly = async (fn) => {
    const warn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
      return { result: await fn(), warnings };
    } finally {
      console.warn = warn;
    }
  };

  it("counts what the Cooperative's PNK streams can refund, on Lockup v1 and v2+", async () => {
    const chain = new FakeChain();
    lockup(chain, LOCKUP_V2, {
      version: 2,
      streams: {
        1: { sender: COOP[0], token: PNK, refundable: 100 },
        2: { sender: OUTSIDER, token: PNK, refundable: 1000 },
        // the Arbitrum Lockups stream USDC and DAI too, and DAI also has 18 decimals
        3: { sender: COOP[1], token: OTHER_TOKEN, refundable: 500 },
        4: { sender: COOP[1], token: PNK, refundable: 0 },
      },
    });
    lockup(chain, LOCKUP_V1, { version: 1, streams: { 1: { sender: COOP[1], token: PNK, refundable: 50 } } });
    erc20(chain, PNK, { [LOCKUP_V2]: 2000, [LOCKUP_V1]: 50 });
    const result = await scan(chain, [LOCKUP_V2, LOCKUP_V1]);
    assert.equal(total(result), "150");
    assert.deepEqual(
      result.details.map(({ streamId, pnk }) => [streamId, pnk.toNumber()]),
      [
        [1, 100],
        [1, 50],
      ]
    );
  });

  it("doesn't scan a contract holding no PNK", async () => {
    const chain = new FakeChain();
    chain.contract(LOCKUP_V2, SABLIER_ABI, {
      nextStreamId: () => {
        throw new Error("scanned a contract holding no PNK");
      },
    });
    erc20(chain, PNK, {});
    assert.equal(total(await scan(chain, [LOCKUP_V2])), "0");
  });

  it("leaves out streams created after the pinned block", async () => {
    const chain = new FakeChain();
    lockup(chain, LOCKUP_V2, {
      version: 2,
      nextStreamId: 2,
      streams: {
        1: { sender: COOP[0], token: PNK, refundable: 100 },
        2: { sender: COOP[0], token: PNK, refundable: 9 },
      },
    });
    erc20(chain, PNK, { [LOCKUP_V2]: 2000 });
    assert.equal(total(await scan(chain, [LOCKUP_V2])), "100");
  });

  it("stops when a stream's token can't be read", async () => {
    const chain = new FakeChain();
    chain.contract(LOCKUP_V2, SABLIER_ABI, {
      nextStreamId: pinned(() => 2),
      getSender: pinned(() => COOP[0]),
    });
    erc20(chain, PNK, { [LOCKUP_V2]: 2000 });
    await withoutRetryDelays(() => assert.rejects(scan(chain, [LOCKUP_V2]), /Could not read the token of stream 1/));
  });

  it("stops when the streams refund more PNK than the contract holds", async () => {
    const chain = new FakeChain();
    lockup(chain, LOCKUP_V2, { version: 2, streams: { 1: { sender: COOP[0], token: PNK, refundable: 1000 } } });
    erc20(chain, PNK, { [LOCKUP_V2]: 999 });
    await assert.rejects(scan(chain, [LOCKUP_V2]), /more than the 999 wei the contract holds/);
  });

  it("skips a price-gated stream whose refundable amount reverts", async () => {
    const chain = new FakeChain();
    lockup(chain, LOCKUP_V2, {
      version: 2,
      streams: {
        1: {
          sender: COOP[0],
          token: PNK,
          model: PRICE_GATED,
          refundable: () => {
            throw new Revert();
          },
        },
        2: { sender: COOP[0], token: PNK, refundable: 100 },
      },
    });
    erc20(chain, PNK, { [LOCKUP_V2]: 2000 });
    const { result, warnings } = await quietly(() => withoutRetryDelays(() => scan(chain, [LOCKUP_V2])));
    assert.equal(total(result), "100");
    assert.equal(warnings.length, 1);
  });

  it("stops when the refundable amount of a stream that isn't price-gated reverts", async () => {
    const chain = new FakeChain();
    lockup(chain, LOCKUP_V2, {
      version: 2,
      streams: {
        1: {
          sender: COOP[0],
          token: PNK,
          refundable: () => {
            throw new Revert();
          },
        },
      },
    });
    erc20(chain, PNK, { [LOCKUP_V2]: 2000 });
    // the stream's own revert, not a skip and not some other failure
    await withoutRetryDelays(() => assert.rejects(scan(chain, [LOCKUP_V2]), /refundableAmountOf/));
  });

  it(
    "stops when the RPC fails to read a price-gated stream, instead of taking it for its revert",
    { todo: "master skips the stream; fixed on branch fix/throw-instead-of-warning" },
    async () => {
      const chain = new FakeChain();
      lockup(chain, LOCKUP_V2, {
        version: 2,
        streams: {
          1: {
            sender: COOP[0],
            token: PNK,
            model: PRICE_GATED,
            refundable: () => {
              throw new RpcFailure();
            },
          },
        },
      });
      erc20(chain, PNK, { [LOCKUP_V2]: 2000 });
      await quietly(() =>
        withoutRetryDelays(() => assert.rejects(scan(chain, [LOCKUP_V2]), /503 Service Unavailable/))
      );
    }
  );
});

describe("LlamaPay vesting escrows", () => {
  const FACTORY = address(0x6661);
  const FACTORY_ABI = [
    "event VestingEscrowCreated(address indexed funder, address indexed token, address indexed recipient, address escrow, uint256 amount, uint256 vesting_start, uint256 vesting_duration, uint256 cliff_length, bool open_claim)",
    "function escrows_length() view returns (uint256)",
  ];
  const ESCROW_ABI = ["function owner() view returns (address)", "function locked() view returns (uint256)"];

  /*
   * escrows: [{ funder, token, owner, locked, holds, createdAt }]; the factory counts `escrowsLength`
   * escrows at the pinned block, by default every escrow created up to it.
   */
  const llamaPay = ({ escrows, escrowsLength, fromBlock = 100 }) => {
    const chain = new FakeChain();
    const factory = chain.contract(FACTORY, FACTORY_ABI, {
      escrows_length: pinned(() => escrowsLength ?? escrows.filter(({ createdAt }) => createdAt <= BLOCK).length),
    });
    const holdings = {};
    escrows.forEach(({ funder, token, owner, locked, holds = locked, createdAt }, i) => {
      const escrow = address(0x7000 + i);
      factory.emit("VestingEscrowCreated", [funder, token, OUTSIDER, escrow, 0, 0, 0, 0, false], {
        blockNumber: createdAt,
      });
      chain.contract(escrow, ESCROW_ABI, { owner: pinned(() => owner), locked: pinned(() => locked) });
      if (token === PNK) holdings[escrow] = holds;
    });
    erc20(chain, PNK, holdings);
    return getCoopVestingEscrowPnk({
      provider: chain,
      factory: FACTORY,
      fromBlock,
      pnkAddress: PNK.toLowerCase(),
      excludedAddresses: COOP,
      blockTag: BLOCK,
    });
  };

  const owned = { funder: COOP[1], token: PNK, owner: COOP[1], locked: 700, holds: 900, createdAt: 200 };

  it("counts the unvested PNK of escrows the Cooperative funded and still owns", async () => {
    const result = await llamaPay({
      escrows: [
        owned,
        // disowned or revoked: the unvested PNK can't come back any more
        { ...owned, owner: constants.AddressZero, locked: 300 },
        // anyone can name the Cooperative as owner of an escrow they fund
        { ...owned, funder: OUTSIDER, owner: COOP[0], locked: 5000 },
        { ...owned, token: OTHER_TOKEN, locked: 100 },
        { ...owned, owner: OUTSIDER, locked: 50 },
        { ...owned, locked: 0 },
      ],
    });
    assert.equal(total(result), "700");
    assert.equal(result.details.length, 1);
  });

  it("leaves out escrows created after the pinned block", async () => {
    const result = await llamaPay({ escrows: [owned, { ...owned, createdAt: BLOCK + 1 }] });
    assert.equal(total(result), "700");
  });

  it("stops when the factory created escrows its events don't account for", async () => {
    await assert.rejects(llamaPay({ escrows: [owned], escrowsLength: 2 }), /had created 2 escrows/);
    await assert.rejects(llamaPay({ escrows: [owned, { ...owned, createdAt: 50 }] }), /had created 2 escrows/);
  });

  it("stops on an escrow holding less PNK than it reports locked", async () => {
    await assert.rejects(
      llamaPay({ escrows: [{ ...owned, holds: 600 }] }),
      /reports 700 wei locked but only holds 600/
    );
  });
});
