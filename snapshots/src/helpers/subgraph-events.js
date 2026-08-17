import { BigNumber, utils } from "ethers";
import { fetchJson } from "./fetch-json.js";

const fetchStakeSets = async (blockStart, blockEnd, subgraphEndpoint, lastId) => {
  const subgraphQuery = {
    query: `
        {
          _meta {
            block {
              number
            }
            hasIndexingErrors
          }
          stakeSets(where: {
            blocknumber_gte: ${blockStart},
            blocknumber_lt: ${blockEnd},
            id_gt: "${lastId}"
          },
          orderBy: id,
          orderDirection: asc,
          first: 1000) {
            id
            address
            subcourtID
            stake
            newTotalStake
            logIndex
            blocknumber
          }
        }
      `,
  };
  const response = await fetchJson(subgraphEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(subgraphQuery),
    // the subgraph reports query errors in-band, with a 200 status — most of them transient
    // indexer hiccups, so throwing inside the fetch gets them retried like any other failure
    validate: (json) => {
      if (!json.data?.stakeSets || !json.data?._meta) {
        throw new Error(`Subgraph query to ${subgraphEndpoint} failed: ${JSON.stringify(json.errors ?? json)}`);
      }
      /*
       * The stakeSets filter is on an entity field, not a pinned query: a subgraph that hasn't
       * indexed the whole range yet returns whatever events it has — a silently truncated stake
       * history, and therefore a wrong average. `_meta` rides in the same request, so it describes
       * the exact indexer state that produced this page — which matters through the gateway, where
       * every page may be served by a different indexer. A lagging indexer is transient, so
       * throwing here puts catching up on the same retry loop as any other hiccup.
       */
      const meta = json.data._meta;
      if (meta.hasIndexingErrors) {
        throw new Error(
          `The subgraph at ${subgraphEndpoint} reports indexing errors — its stake history cannot be trusted`
        );
      }
      // blockEnd - 1 because blocknumber_lt is exclusive: that is the highest block whose events
      // this query can return, so it is exactly how far the subgraph must have indexed.
      if (meta.block.number < blockEnd - 1) {
        throw new Error(
          `The subgraph at ${subgraphEndpoint} has only indexed up to block ${meta.block.number}, ` +
            `but the stake history is needed through block ${blockEnd - 1}`
        );
      }
    },
  });

  return response.data.stakeSets;
};

const fetchAllStakeSets = async (blockStart, blockEnd, subgraphEndpoint) => {
  const batches = [];
  let lastId = "";
  for (let i = 0; i < 1000; i++) {
    //console.log("Stake sets batch", batches.length);
    const sets = await fetchStakeSets(blockStart, blockEnd, subgraphEndpoint, lastId);
    //console.log("Batch got length:", sets.length);
    batches.push(sets);
    if (sets.length < 1000) break;
    lastId = sets[999].id;
  }
  return batches.flat(1);
};

const parseStakeSetsIntoEvents = (subgraphStakeSets) => {
  return subgraphStakeSets.map((s) => {
    return {
      args: {
        _address: utils.getAddress(s.address), // to checksum
        _subcourtID: BigNumber.from(s.subcourtID),
        _stake: BigNumber.from(s.stake),
        _newTotalStake: BigNumber.from(s.newTotalStake),
      },
      logIndex: Number(s.logIndex),
      blockNumber: Number(s.blocknumber),
    };
  });
};

export const getStakeSets = async (blockStart, blockEnd, chainId) => {
  let endpoint;
  if (chainId === 1) {
    endpoint = process.env.SUBGRAPH_KLEROS_DISPLAY_MAINNET;
  } else if (chainId === 100) {
    endpoint = process.env.SUBGRAPH_KLEROS_DISPLAY_GNOSIS;
  } else {
    throw new Error("Unsupported Chain, nor mainnet nor gnosis");
  }
  const subgraphStakeSets = await fetchAllStakeSets(blockStart, blockEnd, endpoint);
  const parsed = parseStakeSetsIntoEvents(subgraphStakeSets);
  const sorted = parsed.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return a.logIndex - b.logIndex;
    } else return a.blockNumber - b.blockNumber;
  });
  return sorted;
};
