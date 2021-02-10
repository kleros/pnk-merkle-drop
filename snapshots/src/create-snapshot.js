import { MerkleTree } from "@kleros/merkle-tree";
import { BigNumber, Contract } from "ethers";
import { readFile } from "fs/promises";
import {
  compose,
  curry,
  filter,
  groupBy,
  into,
  map,
  mapObjIndexed,
  path,
  pathOr,
  pluck,
  reduce,
  toPairs,
  values,
} from "ramda";
import { getEvents, getLatestEvent } from "./helpers/events.js";

export async function createSnapshotCreator({
  provider,
  klerosLiquidAddress,
  droppedAmount,
  frequency = "monthly",
  concurrency = 5,
}) {
  const KlerosLiquid = JSON.parse(await readFile(new URL("./assets/KlerosLiquid.json", import.meta.url)));
  const klerosLiquid = new Contract(klerosLiquidAddress, KlerosLiquid.abi, provider);

  async function createSnapshot({ fromBlock = 0, toBlock } = {}) {
    toBlock = toBlock || (await provider.getBlockNumber());

    const stakesByAddress = await getLatestStakesByAddress({ fromBlock, toBlock });

    const totalStaked = sumAll(values(stakesByAddress));

    const claimInfoByAddress = getClaimInfo(getClaimValueFromAmounts(droppedAmount, totalStaked), stakesByAddress);
    const claimInfoList = values(claimInfoByAddress);

    const totalClaimable = compose(sumAll, pluck("value"))(claimInfoList);

    const nodes = pluck("node", claimInfoList);

    const mt = new MerkleTree(nodes);

    const claims = map(
      (claimInfo) => ({
        ...claimInfo,
        proof: mt.getHexProof(claimInfo.node),
      }),
      claimInfoByAddress
    );

    const rateBasisPoints = toBasisPoints(getRateWithMultiplier(droppedAmount, totalStaked));
    const apy = calculateApy(rateBasisPoints, frequency);

    return {
      merkleTree: {
        claims,
        root: mt.getHexRoot(),
        width: mt.getWidth(),
        height: mt.getHeight(),
      },
      blockHeight: toBlock,
      totalStaked,
      droppedAmount,
      totalClaimable,
      apy,
    };
  }

  async function getLatestStakesByAddress({ fromBlock, toBlock }) {
    const events = await getAllStakeSetEvents({ fromBlock, toBlock });

    const groupByAddress = groupBy(path(["args", "_address"]));
    const groupedEvents = groupByAddress(events);

    const getLatestStake = ([address, events]) => {
      const latestEvent = getLatestEvent(events);
      const stake = pathOr(BigNumber.from(0), ["args", "_newTotalStake"], latestEvent);

      return [address, stake];
    };
    const onlyNonZero = ([_, stake]) => !BigNumber.from(stake).isZero();
    const transducer = compose(map(getLatestStake), filter(onlyNonZero));

    return into({}, transducer, toPairs(groupedEvents));
  }

  async function getAllStakeSetEvents({ fromBlock, toBlock }) {
    return await getEvents(klerosLiquid, klerosLiquid.filters.StakeSet(), {
      fromBlock,
      toBlock,
      concurrency,
    });
  }

  return createSnapshot;
}

const bnSum = (acc, current) => acc.add(BigNumber.from(current));
const sumAll = reduce(bnSum, BigNumber.from(0));

function getClaimInfo(getValue, stakes) {
  const claimInfoByAddress = mapObjIndexed((stake, address) => {
    const value = getValue(stake);

    return {
      stake,
      value,
      // What need to be commited is the claimable value, not the stake.
      node: MerkleTree.makeLeafNode(address, String(value)),
    };
  }, stakes);

  return claimInfoByAddress;
}

const getClaimValueFromAmounts = curry(function _getClaimValue(droppedAmount, totalStaked, stake) {
  return stake.mul(droppedAmount).div(totalStaked);
});

const BASIS_POINTS_MULTIPLIER = 10000;

// Make the calculations take place always in terms of full tokens (10^18)
const RATE_MULTIPLIER = BigNumber.from("1000000000000000000");

function getRateWithMultiplier(droppedAmount, totalStaked) {
  return droppedAmount.mul(RATE_MULTIPLIER).div(totalStaked);
}

function toBasisPoints(rateWithMultiplier) {
  // To transfom the rate into basis points we divide it by 10^14
  return rateWithMultiplier.div(BigNumber.from("100000000000000"));
}

function calculateApy(rateBasisPoints, frequency) {
  frequency = String(frequency).replace(/(s|ly)$/, "");

  const intervalToYear = {
    year: 1,
    month: 12,
    week: 48, // considering only 4 weeks per month.
    day: 365,
    hour: 24 * 365,
    minute: 60 * 24 * 365,
  };

  if (!intervalToYear[frequency]) {
    throw new Error(`Invalid frequency ${frequency}`);
  }

  const n = intervalToYear[frequency];
  const i = Number(rateBasisPoints);

  return (n * i) / BASIS_POINTS_MULTIPLIER;
}
