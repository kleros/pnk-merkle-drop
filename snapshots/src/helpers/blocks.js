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

export function createGetBlock(provider) {
  let networkPromise = provider.getNetwork();

  return async function getBlock(blockHeight) {
    const { chainId } = await networkPromise;
    hotCache[chainId] = hotCache[chainId] ?? {};

    if (!hotCache[chainId]?.[blockHeight]) {
      debug(`Hot cache miss for block ${blockHeight}. Fetching from persistent cache...`);

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

        request.then((data) => persistentCache.put(`${chainId}/${blockHeight}`, JSON.stringify(data)));

        hotCache[chainId][blockHeight] = request;
      }
    }

    const data = await hotCache[chainId][blockHeight];
    return pick(PROPS_WHITELIST, data);
  };
}
