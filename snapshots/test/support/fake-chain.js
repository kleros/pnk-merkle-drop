import { utils } from "ethers";

/** Thrown by a fake contract function to make the call revert, with `data` as the revert data. */
export class Revert extends Error {
  constructor(data = "0x") {
    super("execution reverted");
    this.data = data;
  }
}

/** Thrown by a fake contract function to make the RPC fail to answer, as on an outage. */
export class RpcFailure extends Error {
  constructor(message = "503 Service Unavailable") {
    super(message);
    this.code = "SERVER_ERROR";
  }
}

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * A provider backed by JavaScript fakes of contracts, enough for ethers' Contract to call them and to
 * query their events. A fake function gets the decoded arguments and `{ blockTag, storage }` and returns
 * the result (an array for several outputs); throwing Revert makes the call revert, throwing anything
 * else makes the RPC call itself fail. `storage` holds what an eth_call state override wrote.
 * Multicall3's aggregate3 is built in, so code can batch calls through it as on the real chains.
 */
export class FakeChain {
  constructor({ chainId = 1, head = 1000000, timestampOf = (number) => number } = {}) {
    this._isProvider = true;
    this.chainId = chainId;
    this.head = head;
    this.timestampOf = timestampOf;
    this.contracts = new Map();
    this.logs = [];
    this.calls = [];

    this.contract(
      MULTICALL3,
      [
        "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)",
      ],
      {
        aggregate3: ([calls], context) =>
          calls.map(({ target, allowFailure, callData }) => {
            const result = this.execute(target, callData, context);
            if (!result.success && !allowFailure) throw new Revert();
            return result;
          }),
      }
    );
  }

  /** Deploys a fake at `address`. Returns a handle to emit its events with. */
  contract(address, abi, functions) {
    const iface = new utils.Interface(abi);
    this.contracts.set(address.toLowerCase(), { iface, functions });
    return {
      address,
      iface,
      emit: (event, values, { blockNumber, logIndex = 0 }) => {
        const { topics, data } = iface.encodeEventLog(iface.getEvent(event), values);
        this.logs.push({
          address: utils.getAddress(address),
          topics,
          data,
          blockNumber,
          logIndex,
          blockHash: utils.hexZeroPad(utils.hexlify(blockNumber), 32),
          transactionHash: utils.hexZeroPad(utils.hexlify(this.logs.length + 1), 32),
          transactionIndex: 0,
          removed: false,
        });
      },
    };
  }

  execute(to, data, context) {
    const fake = this.contracts.get(to.toLowerCase());
    // An account without code answers any call with empty data.
    if (!fake) return { success: true, returnData: "0x" };
    let call;
    try {
      call = fake.iface.parseTransaction({ data });
    } catch (error) {
      // An unknown selector reverts, as on a contract without a fallback.
      return { success: false, returnData: "0x" };
    }
    const fn = fake.functions[call.name];
    if (!fn) return { success: false, returnData: "0x" };
    try {
      const result = fn(call.args, context);
      const values = call.functionFragment.outputs.length === 1 ? [result] : result;
      return { success: true, returnData: fake.iface.encodeFunctionResult(call.functionFragment, values) };
    } catch (error) {
      if (error instanceof Revert) return { success: false, returnData: error.data };
      throw error;
    }
  }

  getNetwork() {
    return Promise.resolve({ chainId: this.chainId, name: "fake" });
  }

  getBlockNumber() {
    return Promise.resolve(this.head);
  }

  getBlock(number) {
    return Promise.resolve(number > this.head ? null : { number, timestamp: this.timestampOf(number) });
  }

  resolveName(name) {
    return Promise.resolve(name);
  }

  // A reverted call answers with its revert data, which ethers then fails to decode as a result.
  async call(transaction, blockTag) {
    const tag = await blockTag;
    this.calls.push({ to: transaction.to, data: transaction.data, blockTag: tag });
    return this.execute(transaction.to, transaction.data, { blockTag: tag ?? this.head, storage: {} }).returnData;
  }

  // JSON-RPC, for what ethers has no method for: eth_call with a state override.
  async send(method, [transaction, blockTag, stateOverride = {}]) {
    if (method !== "eth_call") throw new Error(`FakeChain doesn't implement ${method}`);
    const storage = {};
    for (const [address, { stateDiff = {} }] of Object.entries(stateOverride)) {
      for (const [slot, value] of Object.entries(stateDiff)) storage[`${address.toLowerCase()}:${slot}`] = value;
    }
    const tag = blockTag === "latest" ? this.head : Number(blockTag);
    return this.execute(transaction.to, transaction.data, { blockTag: tag, storage }).returnData;
  }

  async getLogs(filter) {
    const from = filter.fromBlock === undefined ? 0 : Number(filter.fromBlock);
    const to = filter.toBlock === undefined || filter.toBlock === "latest" ? this.head : Number(filter.toBlock);
    const matches = (log) =>
      (!filter.address || log.address.toLowerCase() === filter.address.toLowerCase()) &&
      log.blockNumber >= from &&
      log.blockNumber <= to &&
      (filter.topics || []).every(
        (topic, i) =>
          topic === null ||
          topic === undefined ||
          [].concat(topic).some((option) => option.toLowerCase() === log.topics[i])
      );
    return this.logs.filter(matches).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }
}

/**
 * Makes retry()'s backoff (1s, 2s, 4s between attempts) instant while `fn` runs, so a test can exhaust
 * the retries of a call that keeps failing.
 */
export async function withoutRetryDelays(fn) {
  const setTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => setTimeout(callback, 0, ...args);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = setTimeout;
  }
}
