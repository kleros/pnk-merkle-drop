import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import leveldown from "leveldown";
import levelup from "levelup";
import { dirname, join, resolve } from "path";
import { pick } from "ramda";
import { fileURLToPath } from "url";
import { debuglog } from "util";

const debug = debuglog("blocks");

const persistentCache = levelup(leveldown(resolve(join(dirname(fileURLToPath(import.meta.url)), "../../.cache/"))));

const PROPS_WHITELIST = ["timestamp"];

const hotCache = {};

dayjs.extend(utc);

const AVG_BLOCKS_PER_SECOND = Number(process.env.PNK_DROP_AVERAGE_BLOCKS_PER_SECOND);
const AVG_BLOCKS_PER_DAY = Math.ceil(24 * 60 * 60 * AVG_BLOCKS_PER_SECOND);

export function createBlockFetchers(provider) {
  /**
   * Finds the height of the first block after the given `date` (inclusive).
   *
   * @param {Date} date the reference date.
   * @return {number} The block height.
   */
  async function findFirstAfter(date) {
    const referenceTimestamp = dayjs.utc(date).unix();

    const currentBlockHeight = await provider.getBlockNumber();
    const currentBlock = await provider.getBlock(currentBlockHeight);

    if (currentBlock.timestamp < referenceTimestamp) {
      throw new Error(`No block after: ${date}`);
    }

    let pivot = currentBlockHeight - Math.ceil((currentBlock.timestamp - referenceTimestamp) * AVG_BLOCKS_PER_SECOND);

    let [high, low] = await Promise.all([
      findAnyAfter(referenceTimestamp, pivot, currentBlockHeight),
      findAnyBefore(referenceTimestamp, pivot),
    ]);

    while (low != high) {
      const mid = Math.floor((low + high) / 2);
      const midBlock = await provider.getBlock(mid);
      if (midBlock.timestamp <= referenceTimestamp) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    debug("findFirstAfter:", high);
    return high;
  }

  /**
   * Finds the height of the last block before the given `date` (exclusive).
   *
   * @param {Date} date the reference date.
   * @return {number} The block height.
   */
  async function findLastBefore(date) {
    const referenceTimestamp = dayjs.utc(date).unix();

    const currentBlockHeight = await provider.getBlockNumber();
    const currentBlock = await provider.getBlock(currentBlockHeight);

    if (currentBlock.timestamp < referenceTimestamp) {
      throw new Error(`No block before: ${date}`);
    }

    let pivot = currentBlockHeight - Math.ceil((currentBlock.timestamp - referenceTimestamp) * AVG_BLOCKS_PER_SECOND);

    let [high, low] = await Promise.all([
      findAnyAfter(referenceTimestamp, pivot, currentBlockHeight),
      findAnyBefore(referenceTimestamp, pivot),
    ]);

    while (low != high) {
      const mid = Math.floor((low + high) / 2);
      const midBlock = await provider.getBlock(mid);
      if (midBlock.timestamp >= referenceTimestamp) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    debug("findLastBefore:", high - 1);
    return high - 1;
  }

  /**
   * Looks for a block whose timestamp is lower than the reference.
   * Jump size increases linearly after each attempt.
   *
   * @param {number} referenceTimestamp The referencte Unix timestamp to compare against.
   * @param {number} hintHeight The start point for the search.
   * @return {number} The block height of the found block.
   */
  async function findAnyBefore(referenceTimestamp, hintHeight) {
    let height = hintHeight - AVG_BLOCKS_PER_DAY;
    let factor = 1;

    while (height > 0) {
      const block = await provider.getBlock(height);
      if (block.timestamp < referenceTimestamp) {
        return height;
      } else {
        factor += 1;
        height = Math.max(height - factor * AVG_BLOCKS_PER_DAY, 0);
      }
    }

    return 0;
  }

  /**
   * Looks for a block whose timestamp is higher than the reference.
   * Jump size increases linearly after each attempt.
   *
   * @param {number} referenceTimestamp The referencte Unix timestamp to compare against.
   * @param {number} hintHeight The start point for the search.
   * @param {number} currentHeight The current block height, used as a stop criterion.
   * @return {number} The block height of the found block.
   */
  async function findAnyAfter(referenceTimestamp, hintHeight, currentHeight) {
    let height = hintHeight + AVG_BLOCKS_PER_DAY;
    let factor = 1;

    while (height < currentHeight) {
      const block = await provider.getBlock(height);
      if (block.timestamp > referenceTimestamp) {
        return height;
      } else {
        factor += 1;
        height = Math.min(height + factor * AVG_BLOCKS_PER_DAY, currentHeight);
      }
    }

    return currentHeight;
  }

  return { findFirstAfter, findLastBefore };
}

export function createGetBlockWithTimestamp(provider) {
  let networkPromise = provider.getNetwork();

  return async function getBlock(blockHeight) {
    const { chainId } = await networkPromise;
    hotCache[chainId] = hotCache[chainId] ?? {};

    if (!hotCache[chainId]?.[blockHeight]) {
      // debug(`Hot cache miss for block ${blockHeight}. Fetching from persistent cache...`);

      let persistedData;
      try {
        persistedData = await persistentCache.get(`${chainId}/${blockHeight}`);
      } catch (err) {
        if (err.type !== "NotFoundError") {
          throw err;
        }
        debug(`Persistent cache miss for block ${blockHeight}. Fetching from the blockchain...`);
      }

      if (persistedData) {
        hotCache[chainId][blockHeight] = JSON.parse(persistedData);
      } else {
        const request = provider.getBlock(blockHeight);

        request.then((data) => {
          debug(`Successfully fetched data for block ${blockHeight} from the blockchain.`);
          return persistentCache.put(`${chainId}/${blockHeight}`, JSON.stringify(data));
        });

        hotCache[chainId][blockHeight] = request;
      }
    }

    const data = await hotCache[chainId][blockHeight];
    return pick(PROPS_WHITELIST, data);
  };
}
