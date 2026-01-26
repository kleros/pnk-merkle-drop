import { BigNumber, utils } from "ethers";
import fetch from "node-fetch";

const isV2 = (chainId) => chainId === 42161;

const fetchStakeSets = async (blockStart, blockEnd, subgraphEndpoint, lastId, chainId) => {

  const query = isV2(chainId)
    ? `
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
          juror {
            id
          }
          courtID
          stake
          newTotalStake
          logIndex
          blocknumber
        }
      }
    `
    : `
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
    `;

  const response = await fetch(subgraphEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const { data } = await response.json();
  return data.stakeSets;
};

const fetchAllStakeSets = async (blockStart, blockEnd, subgraphEndpoint, chainId) => {
  const batches = [];
  let lastId = "";
  for (let i = 0; i < 1000; i++) {
    //console.log("Stake sets batch", batches.length);
    const sets = await fetchStakeSets(blockStart, blockEnd, subgraphEndpoint, lastId, chainId);
    //console.log("Batch got length:", sets.length);
    batches.push(sets);
    if (sets.length < 1000) break;
    lastId = sets[999].id;
  }
  return batches.flat(1);
};

const parseStakeSetsIntoEvents = (subgraphStakeSets, chainId) => {
  return subgraphStakeSets.map((s) => {
    return {
      args: isV2(chainId)
        ? {
          _address: utils.getAddress(s.juror.id), // to checksum
          _courtID: BigNumber.from(s.courtID),
          _stake: BigNumber.from(s.stake),
          _newTotalStake: BigNumber.from(s.newTotalStake),
        }
        : {
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
    endpoint = "https://api.studio.thegraph.com/query/61738/kleros-display-mainnet/version/latest";
  } else if (chainId === 100) {
    endpoint = "https://api.studio.thegraph.com/query/61738/kleros-display-gnosis/version/latest";
  } else if (chainId === 42161) {
    endpoint = "https://api.studio.thegraph.com/query/44313/kleros-v2-neo-mainnet/version/latest";
  } else {
    throw new Error("Unsupported chain");
  }

  const subgraphStakeSets = await fetchAllStakeSets(blockStart, blockEnd, endpoint, chainId);
  const parsed = parseStakeSetsIntoEvents(subgraphStakeSets, chainId);
  const sorted = parsed.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return a.logIndex - b.logIndex;
    } else return a.blockNumber - b.blockNumber;
  });

  return sorted;
};
