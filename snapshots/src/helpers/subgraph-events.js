import { BigNumber, utils } from "ethers";
import { fetchJson } from "./fetch-json.js";

const fetchStakeSets = async (blockStart, blockEnd, subgraphEndpoint, lastId) => {
  const subgraphQuery = {
    query: `
        {
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
      if (!json.data?.stakeSets) {
        throw new Error(`Subgraph query to ${subgraphEndpoint} failed: ${JSON.stringify(json.errors ?? json)}`);
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
