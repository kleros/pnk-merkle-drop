// import asyncMap from "awaity/esm/fp/map.js";
import _asyncMapLimit from "awaity/fp/mapLimit.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import { flatten, map, range } from "ramda";

dayjs.extend(utc);

const asyncMapLimit = typeof _asyncMapLimit === "function" ? _asyncMapLimit : _asyncMapLimit.default;

/**
 * @typedef {import('ethers').Contract} Contract
 * @typedef {import('ethers').EventFilter} EventFilter
 * @typedef {import('ethers').Event} Event
 *
 * @typedef {Event & { timestamp: number }} EventWithTimestamp
 */

/**
 * @type {number}
 */
export const DEFAULT_BLOCK_BATCH_SIZE = 1000000;

/**
 * @typedef {object} BlockRange
 * @prop {number | 'latest'} fromBlock The block to start from [inclusive].
 * @prop {number | 'latest'} toBlock The block to end with [inclusive].
 */

/**
 * @typedef {object} BlockBatchParams
 * @prop {number} concurrency The number of concurrent queries.
 * @prop {number} [batchSize=DEFAULT_BLOCK_BATCH_SIZE] The size of each batch.
 */

export function createGetEvents(getBlock) {
  /**
   * Gets all events from from a contract matching the filter.
   * @function
   * @param {Contract} contract The contract instance.
   * @param {EventFilter} filter The event filter.
   * @param {BlockRange & BlockBatchParams} options The options object.
   * @return {EventWithTimestamp[]} The index of the element in the arrya or -1 if not found.
   */
  return async function getEvents(
    contract,
    filter,
    { fromBlock, toBlock, concurrency, batchSize = DEFAULT_BLOCK_BATCH_SIZE }
  ) {
    const blockIntervals = splitBlockInterval(fromBlock, toBlock, batchSize);

    const result = await asyncMapLimit(
      ({ from, to }) => contract.queryFilter(filter, from, to),
      concurrency,
      blockIntervals
    );

    return await asyncMapLimit(
      async (event) => {
        const { timestamp } = await getBlock(event.blockNumber);
        return { timestamp, ...event };
      },
      100,
      flatten(result)
    );
  };
}
function splitBlockInterval(fromBlock, toBlock, batchSize) {
  const totalBlocks = toBlock - fromBlock + 1;
  if (totalBlocks <= 0) {
    return [];
  }

  const totalPages = Math.ceil(totalBlocks / batchSize);

  return map((currentPage) => {
    const from = fromBlock + currentPage * batchSize;
    const to = Math.min(from + batchSize - 1, toBlock);

    return { from, to };
  }, range(0, totalPages));
}
