import { MerkleTree } from "@kleros/merkle-tree";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
// import deepMerge from "deepmerge";
import { BigNumber, Contract } from "ethers";
import { readFile } from "fs/promises";
import {
  append,
  clamp,
  compose,
  curry,
  filter,
  findLastIndex,
  groupBy,
  identity,
  into,
  last,
  map,
  mapObjIndexed,
  path,
  pluck,
  prepend,
  prop,
  reduce,
  slice,
  sortBy,
  toPairs,
  values,
} from "ramda";
import { createGetBlockWithTimestamp } from "./helpers/blocks.js";
import { createGetEvents } from "./helpers/events.js";

dayjs.extend(utc);

export async function createSnapshotCreator({
  provider,
  klerosLiquidAddress,
  droppedAmount,
  frequency = "month",
  concurrency = 5,
}) {
  const { getEventsWithTimestamp } = createGetEvents(createGetBlockWithTimestamp(provider));

  const KlerosLiquid = JSON.parse(await readFile(new URL("./assets/KlerosLiquid.json", import.meta.url)));
  const klerosLiquid = new Contract(klerosLiquidAddress, KlerosLiquid.abi, provider);

  async function createSnapshot({ fromBlock = 0, toBlock, startDate, endDate } = {}) {
    toBlock = toBlock || (await provider.getBlockNumber());

    const events = await getAllStakeSetEvents({ fromBlock, toBlock });
    const stakesByAddress = getAverageStakesByAddress({ startDate, endDate }, events);
    const averageTotalStaked = sumAll(values(stakesByAddress));

    const claimsByAddress = map(getClaimValueFromAmounts(droppedAmount, averageTotalStaked), stakesByAddress);

    const claimInfoByAddress = getClaimInfo(stakesByAddress, claimsByAddress);

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

    const rateBasisPoints = toBasisPoints(getRateWithMultiplier(droppedAmount, averageTotalStaked));
    const quantity = Math.max(1, dayjs.utc(endDate).diff(dayjs.utc(startDate), "month"));
    const apy = calculateApy(rateBasisPoints, frequency, quantity);

    return {
      merkleTree: {
        claims,
        root: mt.getHexRoot(),
        width: mt.getWidth(),
        height: mt.getHeight(),
      },
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      blockHeight: toBlock,
      averageTotalStaked,
      droppedAmount,
      totalClaimable,
      apy,
    };
  }

  async function getAllStakeSetEvents({ fromBlock, toBlock }) {
    return await getEventsWithTimestamp(klerosLiquid, klerosLiquid.filters.StakeSet(), {
      fromBlock,
      toBlock,
      concurrency,
    });
  }

  return createSnapshot;
}

/**
 * @typedef {import('ethers').BigNumber} BigNumber
 * @typedef {import('dayjs').Dayjs} Dayjs
 * @typedef {import('./helpers/events.js').EventWithTimestamp} EventWithTimestamp
 */

/**
 * Determines the weighted average of the amount staked by each juror in a given period.
 * @param {Object} options The options for the function.
 * @param {Dayjs} options.startDate The starting date (inclusive) to compute the average.
 * @param {Dayjs} options.endDate The ending date (exclusive) to compute the average.
 * @param {EventWithTimestamp[]} events The events from the contract.
 * @returns {Object<string, BigNumber>} The average stake for the period, indexed by the juror address.
 */
function getAverageStakesByAddress({ startDate, endDate }, events) {
  /**
   * The total stake for a juror is a discrete function of the time as represented below:
   *
   *    A
   *    |            .                                                               .
   *    |            .                                                               .
   *    |            .                              +- Event                         .
   *  T |            .                              |                                .
   *  o |            .                              v                                .
   *  t |            .                              o                                .
   *  a |            .                                                               .
   *  l |            .                                                               .
   *    |   o        .                                                               .
   *  S |            .                                                               .
   *  t |            .                                                               .
   *  a |            .                                                               .
   *  k |            .        o                                                      .
   *  e |            .                                                               .
   *  d |            .                                                               .
   *    |            .                                                     o         .
   *    |            .                                                               .
   *    +------------+---------------------------------------------------------------+--->
   *                 .                  Time                                         .
   *            Start Date                                                        End Date
   *
   * For this specific case, each point represents a `StakeSet` event.
   *
   * In order to get the average amount of tokens staked between Start Date and End Date,
   * we need to transform the discrete function above into a step function like this:
   *
   *    A
   *    |            .                                                               .
   *    |            .                                                               .
   *    |            .                                                               .
   *  T |            .                                                               .
   *  o |            .                                                               .
   *  t |            .                              o----------------------+         .
   *  a |            .                                                               .
   *  l |            .                                                               .
   *    |   o--------.--------+                                                      .
   *  S |            .                                                               .
   *  t |            .                                                               .
   *  a |            .                                                               .
   *  k |            .        o---------------------+                                .
   *  e |            .                                                               .
   *  d |            .                                                               .
   *    |            .                                                     o---------.--------
   *    |            .                                                               .
   *    +------------+---------------------------------------------------------------+--->
   *                 .                  Time                                         .
   *            Start Date                                                        End Date
   *
   * For the beginning of the interval, we must take the value of the last event **before** Start Date
   * and make the function assume its value from Start Date until the next event within the interval.
   *
   * For the end of the interval, we must take the value of the last event within the interval
   * and make the function assume its value from that point until End Date.
   *
   * Then we calculate the average of the values (heights) of the steps weighted by their duration (widths).
   * It's important however be careful with the widths at the edge of the interval, as the step should be "clamped".
   *
   * Special cases:
   *
   * 1. There are no events before Start Date:
   *
   *    A
   *    |            .                                                               .
   *    |            .                                                               .
   *    |            .                              +- Event                         .
   *  T |            .                              |                                .
   *  o |            .                              v                                .
   *  t |            .                              o----------------------+         .
   *  a |            .                                                               .
   *  l |            .                                                               .
   *    |            .                                                               .
   *  S |            .                                                               .
   *  t |            .                                                               .
   *  a |            .                                                               .
   *  k |            .        o---------------------+                                .
   *  e |            .                                                               .
   *  d |            .   +- Assume value zero until the first event                  .
   *    |            .   |                                                 o---------.--------
   *    |            .   v                                                           .
   *    +------------+........+------------------------------------------------------+--->
   *                 .                  Time                                         .
   *            Start Date                                                        End Date
   *
   *
   * 2. There are no events within the interval, but there it:
   *
   *    A
   *    |            .                                                               .
   *    |            .                                                               .
   *    |            .                                                               .
   *  T |            .                                                               .
   *  o |            .                                                               .
   *  t |            .       +- Assume a constant value for the period               .
   *  a |            .       |                                                       .
   *  l |            .       v                                                       .
   *    |   o--------.---------------------------------------------------------------.---
   *  S |            .                                                               .
   *  t |            .                                                               .
   *  a |            .                                                               .
   *  k |            .                                                               .
   *  e |            .                                                               .
   *  d |            .                                                               .
   *    |            .                                                               .
   *    |            .                                                               .
   *    +------------+---------------------------------------------------------------+--->
   *                 .                  Time                                         .
   *            Start Date                                                        End Date
   *
   *
   * 3. There are no events within the interval, neither before it:
   *
   *    A
   *    |            .                                                               .
   *    |            .                                                               .
   *    |            .                                                               .
   *  T |            .                                                               .
   *  o |            .                                                               .
   *  t |            .                Event out ou the interval is not computed -----.---+
   *  a |            .                                                               .   |
   *  l |            .                                                               .   v
   *    |            .                                                               .   o
   *  S |            .                                                               .
   *  t |            .                                                               .
   *  a |            .                                                               .
   *  k |            .                                                               .
   *  e |            .                                                               .
   *  d |            .                                                               .
   *    |            .                                                               .
   *    |            .                                                               .
   *    +------------+---------------------------------------------------------------+--->
   *                 .                  Time                                         .
   *            Start Date                                                        End Date
   */

  // Does the trick of not considering durtions beyond the specified interval
  // Notice that endDate should be exclusive.
  const withinDuration = clamp(startDate.unix(), endDate.unix() - 1);

  const getWeightFromDuration = (end, start) =>
    dayjs.unix(withinDuration(end)).diff(dayjs.unix(withinDuration(start)), "hour");

  const toStepFunction = compose(
    prop("items"),
    reduce(
      ({ previous, items }, item) => {
        if (previous !== null) {
          return {
            items: [
              ...items,
              {
                weight: BigNumber.from(getWeightFromDuration(item.timestamp, previous.timestamp)),
                value: previous.totalStake,
              },
            ],
            previous: item,
          };
        }

        return {
          items,
          previous: item,
        };
      },
      { items: [], previous: null }
    )
  );

  const getLastIndexBefore = (date, events) => {
    const timestamp = date.utc(date).unix();
    return findLastIndex((event) => event.timestamp < timestamp, events);
  };

  const getAverageStake = (eventsFromAccount) => {
    const firstIndex = getLastIndexBefore(startDate, eventsFromAccount);
    const lastIndex = getLastIndexBefore(endDate, eventsFromAccount);

    // This means that no event happened before the end of the interval (see 3. above)
    if (lastIndex === -1) {
      return BigNumber.from(0);
    }

    /*
     * To be able to calculate the weight of the last event we need to introduce a fake event at the end
     * whose totalStake is the same as the last event and the timestamp is the end date.
     */
    const appendFinalEventIfRequired = (events) => {
      const lastEvent = last(events);
      if (!lastEvent) {
        return events;
      }

      return append(
        {
          blockNumber: Number.MAX_SAFE_INTEGER,
          timestamp: endDate.unix(),
          logIndex: Number.MAX_SAFE_INTEGER,
          totalStake: lastEvent.totalStake,
        },
        events
      );
    };

    /*
     * If `firstIndex === -1`, then the first stake of the user happened within [startDate, endDate]
     * This means that the value staked before that was effectively 0.
     * For that reason, we create a fake "event" so this period can be taken into account.
     * Otherwise, we just return the array of events unmodified. (see 1. above)
     */
    const prependFakeEventIfRequired =
      firstIndex === -1
        ? prepend({
            timestamp: startDate.unix(),
            blockNumber: -1,
            logIndex: -1,
            totalStake: BigNumber.from(0),
          })
        : identity;

    // slice's 2nd argument is exclusive, so we need to add 1 to get the last element.
    const getRelevantEvents =
      firstIndex === -1
        ? /* If `firstIndex === -1`, then the fake event will be prepended to the array
           * and we must return one element more (+2 because slice's 2nd argument is exclusive)
           */
          slice(0, lastIndex + 2)
        : // Otherwise just stick with the found elements
          slice(firstIndex, lastIndex + 1);

    const getLastestInBlock = compose(last, sortBy(prop("logIndex")));

    const normalize = compose(
      appendFinalEventIfRequired,
      sortBy(prop("timestamp")),
      values,
      map(getLastestInBlock),
      groupBy(prop("blockNumber")),
      getRelevantEvents,
      prependFakeEventIfRequired
    );
    const events = normalize(eventsFromAccount);

    if (events.length === 0) {
      return 0;
    }

    // Special case where the stake didn't change the entire time (see 2. above).
    if (events.length === 1) {
      return events[0].totalStake;
    }

    return getWeightedAverage(toStepFunction(events));
  };

  const withAverageStake = ([address, events]) => {
    const stake = getAverageStake(events);
    return [address, stake];
  };

  const withRelevantProps = ([address, events]) => {
    return [
      address,
      map(
        (event) => ({
          address,
          blockNumber: event.blockNumber,
          timestamp: event.timestamp,
          logIndex: event.logIndex,
          totalStake: event.args._newTotalStake || BigNumber.from(0),
        }),
        events
      ),
    ];
  };

  const onlyNonZero = ([_, stake]) => !BigNumber.from(stake).isZero();
  const transducer = compose(map(withRelevantProps), map(withAverageStake), filter(onlyNonZero));

  const groupByAddress = groupBy(path(["args", "_address"]));
  const groupedEvents = groupByAddress(events);

  return into({}, transducer, toPairs(groupedEvents));
}

const bnSum = (acc, current) => acc.add(BigNumber.from(current));
const sumAll = reduce(bnSum, BigNumber.from(0));

function getWeightedAverage(values) {
  const getTotalWeight = compose(sumAll, pluck("weight"));
  const getTotalValueTimesWeight = reduce((acc, { value, weight }) => bnSum(acc, value.mul(weight)), BigNumber.from(0));
  return getTotalValueTimesWeight(values).div(getTotalWeight(values));
}

function getClaimInfo(stakes, claims) {
  return mapObjIndexed(
    (averageStake, address) => ({
      averageStake: stakes[address],
      value: claims[address],
      // What need to be commited is the claimable value, not the stake.
      node: MerkleTree.makeLeafNode(address, claims[address]),
    }),
    claims
  );
}

const getClaimValueFromAmounts = curry(function _getClaimValue(droppedAmount, averageTotalStaked, stake) {
  return stake.mul(droppedAmount).div(averageTotalStaked);
});

const BASIS_POINTS_MULTIPLIER = 10000;

// Make the calculations take place always in terms of full tokens (10^18)
const RATE_MULTIPLIER = BigNumber.from("1000000000000000000");

function getRateWithMultiplier(droppedAmount, averageTotalStaked) {
  return droppedAmount.mul(RATE_MULTIPLIER).div(averageTotalStaked);
}

function toBasisPoints(rateWithMultiplier) {
  // To transfom the rate into basis points we divide it by 10^14
  return rateWithMultiplier.div(BigNumber.from("100000000000000"));
}

function calculateApy(rateBasisPoints, frequency, quantity) {
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

  const n = intervalToYear[frequency] / quantity;
  const i = Number(rateBasisPoints);

  return (n * i) / BASIS_POINTS_MULTIPLIER;
}

// async function importFixedClaims() {
//   try {
//     return map(BigNumber.from, JSON.parse(await readFile(new URL("../.cache/1000-claims.json", import.meta.url))));
//   } catch (err) {
//     console.warn("Error importing fixed claims:", err);
//     return {};
//   }
// }
