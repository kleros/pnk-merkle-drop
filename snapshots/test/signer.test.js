import assert from "assert/strict";
import { utils } from "ethers";
import { readFileSync } from "fs";
import { request } from "http";
import { describe, it } from "node:test";
import { CHAINS } from "../src/config.js";
import { seedingTransaction, signerChains, signerUrl } from "../src/seeding.js";
import {
  SELECTORS,
  checkAndSend,
  checkSeeding,
  formatAmount,
  readSeeding,
  seedingSession,
  waitForSeeding,
} from "../src/signer/seed.js";
import { createSignerServer } from "../src/signer/server.js";

// The chains the page gets from the server, which builds them the same way.
const SEED_CHAINS = signerChains(CHAINS);
const read = (search) => readSeeding(search, SEED_CHAINS);

const OWNER = "0x28A81EC3045F079DCf051BA2F3280335D18144cC";
const MAINNET_REDEEM = "0xdbc3088Dfebc3cc6A84B0271DaDe2696DB00Af38";
const GNOSIS_REDEEM = "0xf1A9589880DbF393F32A5b2d5a0054Fa10385074";
const OTHER = "0x1111111111111111111111111111111111111111";

// The October 2026 seedings, as cli.js printed them on 2026-11-01 (weeks 68 and 63).
const OCTOBER = {
  week: 68,
  root: "0x3c4e12574473f45ba03a02bf4987d02427e6703f1c38bb54dd41f0108ca5f3bf",
  amount: "2921589957683974625773330",
  data:
    "0x4cd488ab00000000000000000000000000000000000000000000000000000000000000443c4e12574473f45ba03a02bf4987d02427e6703f1c38bb54dd41f0108ca5f3bf000000000000000000000000000000000000000000026aabb57e82918b5b4712",
};
const OCTOBER_GNOSIS_DATA =
  "0x4cd488ab000000000000000000000000000000000000000000000000000000000000003fdbdf13a7bee2200de04a0f2100f0022db7c04cfb4e7f96e33c575014dbcdc5d40000000000000000000000000000000000000000000044bdbed52af3ba26961e";
const OCTOBER_LINK = `http://127.0.0.1:8765/?chainId=1&to=${MAINNET_REDEEM}&data=${OCTOBER.data}`;
const HASH = `0x${"ab".repeat(32)}`;

const word = (hex) => `0x${hex.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const linkOf = (params) => `?${new URLSearchParams(params)}`;
const october = () => read(new URL(OCTOBER_LINK).search);

/**
 * A wallet whose account is the owner, on the seeding's chain, with nothing pending, and whose node answers like
 * the chain right before the seeding: the MerkleRedeem has the owner and the token, the week before is seeded and
 * the week isn't, the owner holds and has approved exactly the amount, and the seeding simulates. Off the seeding's
 * chain every eth_call answers "0x", as an address without code does.
 *
 * `answers` replaces any of those answers (an Error makes that call fail), and an eth_call the page has no business
 * making fails the test. `during` runs a function, given the wallet's state, right before the eth_call it names is
 * answered, e.g. to change the wallet's account or chain halfway through a check, along with what emits the
 * wallet's events. Switching chains emits chainChanged, as real wallets do. `pending` is how many
 * transactions the owner has pending, and `send` what eth_sendTransaction answers (an Error makes it fail).
 */
function fakeWallet(
  seeding,
  { accounts, chainId, switchTo, answers = {}, during = {}, pending = 0, send = HASH, receipts = [] } = {}
) {
  const { chain, to, data, week, amount } = seeding;
  const owner = chain.owner.toLowerCase();
  const state = { accounts: accounts ?? [owner], chainId: chainId ?? seeding.chainId };
  const all = {
    owner: word(owner),
    token: word(chain.token),
    [`weekMerkleRoots(${week})`]: word("0"),
    [`weekMerkleRoots(${week - 1})`]: word("11"),
    balance: word(amount.toString(16)),
    allowance: word(amount.toString(16)),
    simulation: "0x",
    ...answers,
  };
  const callName = ({ to: target, data: input, from }) => {
    const at = target.toLowerCase();
    if (at === to.toLowerCase() && !from && input === SELECTORS.owner) return "owner";
    if (at === to.toLowerCase() && !from && input === SELECTORS.token) return "token";
    if (at === to.toLowerCase() && !from && input.startsWith(SELECTORS.weekMerkleRoots) && input.length === 74) {
      return `weekMerkleRoots(${BigInt(`0x${input.slice(10)}`)})`;
    }
    if (at === chain.token.toLowerCase() && input === `${SELECTORS.balanceOf}${word(owner).slice(2)}`) return "balance";
    if (
      at === chain.token.toLowerCase() &&
      input === `${SELECTORS.allowance}${word(owner).slice(2)}${word(to).slice(2)}`
    ) {
      return "allowance";
    }
    if (at === to.toLowerCase() && input === data && from?.toLowerCase() === owner) return "simulation";
    throw new Error(`unexpected eth_call to ${target} with ${input}`);
  };
  const calls = [];
  const handlers = {};
  // like a real wallet, it tells the page's listeners when its chain or account changes
  const emit = (event, value) => (handlers[event] || []).forEach((handler) => handler(value));
  return {
    calls,
    emit,
    on(event, handler) {
      (handlers[event] = handlers[event] || []).push(handler);
    },
    sent: () => calls.filter(({ method }) => method === "eth_sendTransaction"),
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return state.accounts;
        case "eth_chainId":
          return `0x${state.chainId.toString(16)}`;
        case "wallet_switchEthereumChain":
          if (switchTo instanceof Error) throw switchTo;
          state.chainId = switchTo ?? Number(params[0].chainId);
          emit("chainChanged", `0x${state.chainId.toString(16)}`);
          return null;
        case "eth_getTransactionCount":
          assert.equal(params[0].toLowerCase(), owner);
          if (answers.transactionCount instanceof Error) throw answers.transactionCount;
          return `0x${(59 + (params[1] === "pending" ? pending : 0)).toString(16)}`;
        case "eth_call": {
          assert.ok(params[1] === "latest" || /^0x[0-9a-f]+$/.test(params[1]), params[1]);
          const name = callName(params[0]);
          during[name]?.(state, emit);
          if (state.chainId !== seeding.chainId) return "0x";
          const answer = all[name];
          if (answer instanceof Error) throw answer;
          return answer;
        }
        case "eth_sendTransaction":
          if (send instanceof Error) throw send;
          return send;
        case "eth_getTransactionReceipt":
          return receipts.length ? receipts.shift() : null;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
}

describe("seeding page", () => {
  it("checks links against the chains of config.js, at their MerkleRedeem, from their owner", () => {
    assert.deepEqual(SEED_CHAINS, {
      1: {
        name: "Ethereum",
        symbol: "PNK",
        explorer: "https://etherscan.io/tx/",
        merkleRedeem: MAINNET_REDEEM,
        owner: OWNER,
        token: "0x93ED3FBe21207Ec2E8f2d3c3de6e058Cb73Bc04d",
      },
      100: {
        name: "Gnosis",
        symbol: "stPNK",
        explorer: "https://gnosisscan.io/tx/",
        merkleRedeem: GNOSIS_REDEEM,
        owner: OWNER,
        token: "0xcb3231aBA3b451343e0Fddfc45883c842f223846",
      },
    });
    assert.throws(() => signerChains([{ ...CHAINS[0], chainId: 42161 }]), /No known network name for chain 42161/);
  });

  it("calls each function by its selector", () => {
    const signatures = {
      seedAllocations: "seedAllocations(uint256,bytes32,uint256)",
      weekMerkleRoots: "weekMerkleRoots(uint256)",
      owner: "owner()",
      token: "token()",
      balanceOf: "balanceOf(address)",
      allowance: "allowance(address,address)",
    };
    assert.deepEqual(Object.keys(SELECTORS).sort(), Object.keys(signatures).sort());
    for (const [name, signature] of Object.entries(signatures)) {
      assert.equal(SELECTORS[name], utils.id(signature).slice(0, 10), name);
    }
  });

  it("loads nothing but its own modules, the logic of which imports nothing and reaches nothing on its own", () => {
    const page = readFileSync(new URL("../src/signer/index.html", import.meta.url), "utf8");
    assert.deepEqual(
      [...page.matchAll(/\bfrom\s+"([^"]+)"/g)].map(([, path]) => path),
      ["./chains.js", "./seed.js"]
    );
    assert.doesNotMatch(page, /\bsrc=|<link\b|@import|https?:\/\/|innerHTML|insertAdjacentHTML|document\.write/);
    const module = readFileSync(new URL("../src/signer/seed.js", import.meta.url), "utf8");
    assert.doesNotMatch(module, /^\s*import\b|\bimport\(|\bfetch\(|XMLHttpRequest|WebSocket/m);
  });

  it("reads the link cli.js printed for the October 2026 seeding", () => {
    const [mainnet] = CHAINS;
    assert.equal(seedingTransaction(OCTOBER).data, OCTOBER.data);
    assert.equal(signerUrl({ ...mainnet, data: OCTOBER.data }), OCTOBER_LINK);
    const seeding = october();
    assert.equal(seeding.chainId, 1);
    assert.equal(seeding.chain, SEED_CHAINS[1]);
    assert.equal(seeding.to, MAINNET_REDEEM);
    assert.equal(seeding.data, OCTOBER.data);
    assert.equal(seeding.week, 68);
    assert.equal(seeding.root, OCTOBER.root);
    assert.equal(seeding.amount, 2921589957683974625773330n);
    assert.equal(formatAmount(seeding.amount), "2921589.95768397462577333");
    // the casing of the address and the data doesn't matter
    assert.deepEqual(
      read(
        linkOf({ chainId: "1", to: MAINNET_REDEEM.toLowerCase(), data: `0x${OCTOBER.data.slice(2).toUpperCase()}` })
      ),
      seeding
    );
  });

  it("writes amounts the way ethers' formatEther does", () => {
    for (const wei of [
      "0",
      "1",
      "1000000000000000000",
      "1000000000000000001",
      "324621106409330513974814",
      "123456789",
    ]) {
      assert.equal(formatAmount(BigInt(wei)), utils.formatEther(wei), wei);
    }
  });

  it("refuses any link the CLI wouldn't print", () => {
    const good = { chainId: "1", to: MAINNET_REDEEM, data: OCTOBER.data };
    const dataOf = (seeding) => seedingTransaction({ ...OCTOBER, ...seeding }).data;
    const cases = [
      [{ ...good, chainId: "42161" }, /chainId 42161 isn't a chain/],
      [{ ...good, chainId: "01" }, /chainId 01 isn't a chain/],
      [{ ...good, chainId: "0x1" }, /chainId 0x1 isn't a chain/],
      [{ ...good, chainId: "100" }, /isn't Gnosis's MerkleRedeem/],
      [{ ...good, to: GNOSIS_REDEEM }, /isn't Ethereum's MerkleRedeem/],
      [{ ...good, data: `0xa9059cbb${OCTOBER.data.slice(10)}` }, /isn't a call to seedAllocations/],
      [{ ...good, data: OCTOBER.data.slice(0, -2) }, /isn't a call to seedAllocations/],
      [{ ...good, data: `${OCTOBER.data}00` }, /isn't a call to seedAllocations/],
      [{ ...good, data: `${OCTOBER.data.slice(0, -1)}g` }, /isn't a call to seedAllocations/],
      [{ ...good, data: dataOf({ week: 0 }) }, /Week 0 isn't a week/],
      [{ ...good, data: dataOf({ root: word("0") }) }, /merkle root is zero/],
      [{ ...good, data: dataOf({ amount: 0 }) }, /amount is zero/],
      [{ ...good, value: "0" }, /"value" parameter/],
      [{ chainId: "1", data: OCTOBER.data }, /exactly one "to"/],
    ];
    for (const [params, error] of cases) assert.throws(() => read(linkOf(params)), error, JSON.stringify(params));
    assert.throws(() => read(`${linkOf(good)}&data=${OCTOBER.data}`), /exactly one "data"/);
  });

  it("sends the seeding once, exactly as the link has it, and only after every check has passed", async () => {
    const seeding = october();
    const wallet = fakeWallet(seeding);
    const passed = [];
    assert.equal(await checkAndSend(wallet, seeding, (line) => passed.push(line)), HASH);
    assert.deepEqual(wallet.sent(), [
      {
        method: "eth_sendTransaction",
        params: [{ from: OWNER, to: MAINNET_REDEEM, data: OCTOBER.data, value: "0x0", chainId: "0x1" }],
      },
    ]);
    // right before it: the simulation of the same transaction, then the account and chain read once more
    const last = wallet.calls.slice(-4);
    assert.deepEqual(last[0].params, [{ from: OWNER, to: MAINNET_REDEEM, data: OCTOBER.data, value: "0x0" }, "latest"]);
    assert.deepEqual(
      last.slice(1).map(({ method }) => method),
      ["eth_accounts", "eth_chainId", "eth_sendTransaction"]
    );
    // a wallet already on the chain isn't asked to switch
    assert.ok(!wallet.calls.some(({ method }) => method === "wallet_switchEthereumChain"));
    assert.deepEqual(passed, [
      `The wallet's account is the owner, ${OWNER}`,
      "The wallet is on Ethereum (chain 1)",
      "The owner has no transaction pending",
      `${MAINNET_REDEEM} is owned by the owner and distributes PNK`,
      "Week 68 isn't seeded yet, and week 67 is",
      "The owner holds 2921589.95768397462577333 PNK and has approved 2921589.95768397462577333 PNK",
      "Simulated as the owner, the seeding succeeds",
    ]);
  });

  it("sends Gnosis's seeding on Gnosis", async () => {
    const seeding = read(linkOf({ chainId: "100", to: GNOSIS_REDEEM, data: OCTOBER_GNOSIS_DATA }));
    assert.equal(seeding.week, 63);
    assert.equal(formatAmount(seeding.amount), "324621.106409330513974814");
    const wallet = fakeWallet(seeding, { chainId: 1 });
    await checkAndSend(wallet, seeding);
    assert.deepEqual(wallet.calls.find(({ method }) => method === "wallet_switchEthereumChain").params, [
      { chainId: "0x64" },
    ]);
    assert.deepEqual(wallet.sent()[0].params, [
      { from: OWNER, to: GNOSIS_REDEEM, data: OCTOBER_GNOSIS_DATA, value: "0x0", chainId: "0x64" },
    ]);

    const missing = fakeWallet(seeding, {
      chainId: 1,
      switchTo: Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }),
    });
    await assert.rejects(
      checkAndSend(missing, seeding),
      /The wallet doesn't have Gnosis \(chain 100\): add it to the wallet, then Check again/
    );
    assert.equal(missing.sent().length, 0);
  });

  it("has the wallet switch chains, and sends nothing until it is on the seeding's chain", async () => {
    const seeding = october();
    const switched = fakeWallet(seeding, { chainId: 100 });
    await checkAndSend(switched, seeding);
    assert.equal(switched.sent().length, 1);

    const elsewhere = fakeWallet(seeding, { chainId: 100, switchTo: 42161 });
    await assert.rejects(checkAndSend(elsewhere, seeding), /The wallet is on chain 42161, not on Ethereum \(chain 1\)/);
    assert.equal(elsewhere.sent().length, 0);

    const refused = fakeWallet(seeding, { chainId: 100, switchTo: new Error("User rejected the request.") });
    await assert.rejects(checkAndSend(refused, seeding), /User rejected the request/);
    assert.equal(refused.sent().length, 0);
  });

  it("sends nothing when any check fails", async () => {
    const seeding = october();
    const amount = BigInt(OCTOBER.amount);
    const toGnosis = (state) => {
      state.chainId = 100;
    };
    const cases = [
      [{ accounts: [OTHER] }, /The wallet's account is 0x1111.*not the owner/],
      [{ accounts: [] }, /The wallet's account is undefined, not the owner/],
      [{ pending: 1 }, /The owner has 1 transaction\(s\) pending: wait until mined/],
      [{ answers: { owner: word(OTHER) } }, /is owned by 0x1111/],
      [{ answers: { owner: "0x" } }, /owner\(\) answered 0x, not a 32-byte word/],
      [{ answers: { token: word(OTHER) } }, /distributes 0x1111.*not PNK/],
      [{ answers: { "weekMerkleRoots(68)": OCTOBER.root } }, /Week 68 is already seeded with this root/],
      [{ answers: { "weekMerkleRoots(68)": word("22") } }, /Week 68 is already seeded, with another root/],
      [{ answers: { "weekMerkleRoots(67)": word("0") } }, /Week 67 isn't seeded, so week 68 isn't the next one/],
      [{ answers: { balance: word((amount - 1n).toString(16)) } }, /The owner holds 2921589.957683974625773329 PNK/],
      [{ answers: { allowance: word((amount - 1n).toString(16)) } }, /approve it first/],
      [{ answers: { simulation: new Error("execution reverted: ERR_TRANSFER_FAILED") } }, /ERR_TRANSFER_FAILED/],
      [{ answers: { simulation: "0x01" } }, /returned 0x01 instead of 0x/],
      // the wallet moving to another chain or account halfway: reads made there answer like an address without code
      [{ during: { owner: toGnosis } }, /owner\(\) answered 0x, not a 32-byte word/],
      [{ during: { simulation: toGnosis } }, /account or chain changed during the checks/],
      [
        {
          during: {
            simulation: (state) => {
              state.accounts = [OTHER];
            },
          },
        },
        /account or chain changed during the checks/,
      ],
    ];
    for (const [options, error] of cases) {
      const wallet = fakeWallet(seeding, options);
      await assert.rejects(checkAndSend(wallet, seeding), error, JSON.stringify(options));
      assert.equal(wallet.sent().length, 0, JSON.stringify(options));
    }
    // a check alone never sends
    const wallet = fakeWallet(seeding);
    await checkSeeding(wallet, seeding);
    assert.equal(wallet.sent().length, 0);
  });

  it("goes on, with a note, when the wallet can't say whether the owner has a transaction pending", async () => {
    const seeding = october();
    const lines = [];
    const wallet = fakeWallet(seeding, { answers: { transactionCount: new Error("method not supported") } });
    await checkSeeding(wallet, seeding, (line, kind) => lines.push([kind, line]));
    assert.deepEqual(
      lines.filter(([kind]) => kind === "note"),
      [["note", "Couldn't read whether the owner has a transaction pending (method not supported): check the wallet"]]
    );
  });

  it("calls an approval of 2^255 wei or more unlimited", async () => {
    const seeding = october();
    for (const [allowance, shown] of [
      [`f${"f".repeat(63)}`, "an unlimited amount"],
      [`8${"0".repeat(63)}`, "an unlimited amount"],
      [`7${"f".repeat(63)}`, "57896044618658097711785492504343953926634992332820282019728.792003956564819967 PNK"],
    ]) {
      const passed = [];
      await checkSeeding(fakeWallet(seeding, { answers: { allowance: word(allowance) } }), seeding, (line) =>
        passed.push(line)
      );
      assert.ok(passed.includes(`The owner holds 2921589.95768397462577333 PNK and has approved ${shown}`), shown);
    }
  });

  it("tells a send the user rejected apart from one the wallet may have sent", async () => {
    const seeding = october();
    const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
    await assert.rejects(
      checkAndSend(fakeWallet(seeding, { send: rejected }), seeding),
      (error) => error.sent === false && error.code === 4001 && /User rejected/.test(error.message)
    );
    await assert.rejects(
      checkAndSend(fakeWallet(seeding, { send: new Error("Device disconnected") }), seeding),
      (error) => error.sent === true && /Device disconnected/.test(error.message)
    );
    await assert.rejects(
      checkAndSend(fakeWallet(seeding, { send: null }), seeding),
      (error) => error.sent === true && /The wallet answered null instead of a transaction hash/.test(error.message)
    );
  });

  it("offers Send only right after an uninterrupted Check, and nothing once the wallet may have sent", async () => {
    const seeding = october();
    const wallet = fakeWallet(seeding);
    const voided = [];
    const session = seedingSession(wallet, seeding, (event, couldSend) => voided.push([event, couldSend]));
    assert.deepEqual([session.canCheck(), session.canSend()], [true, false]);
    await assert.rejects(session.send(), /Check first/);
    await session.check();
    assert.equal(session.canSend(), true);
    // the wallet saying it is on the owner and on the seeding's chain changes nothing
    wallet.emit("chainChanged", "0x1");
    wallet.emit("accountsChanged", [OWNER.toLowerCase()]);
    assert.equal(session.canSend(), true);
    wallet.emit("accountsChanged", [OTHER]);
    assert.equal(session.canSend(), false);
    wallet.emit("chainChanged", "0x64");
    assert.deepEqual(voided, [
      ["accountsChanged", true],
      ["chainChanged", false],
    ]);
    await assert.rejects(session.send(), /Check first/);
    await session.check();
    assert.equal(await session.send(), HASH);
    assert.deepEqual([session.canCheck(), session.canSend()], [false, false]);
    await assert.rejects(session.check(), /may have sent this seeding already/);
    await assert.rejects(session.send(), /may have sent this seeding already/);
    assert.equal(wallet.sent().length, 1);

    // the wallet moving elsewhere during a check
    const changing = fakeWallet(seeding, { during: { token: (state, emit) => emit("chainChanged", "0xa4b1") } });
    const interrupted = seedingSession(changing, seeding);
    await assert.rejects(interrupted.check(), /changed during the checks: Check again/);
    assert.equal(interrupted.canSend(), false);

    // but not the switch to the seeding's chain the check itself asks the wallet for
    const switching = fakeWallet(seeding, { chainId: 100 });
    const switched = seedingSession(switching, seeding);
    await switched.check();
    assert.ok(switching.calls.some(({ method }) => method === "wallet_switchEthereumChain"));
    assert.equal(switched.canSend(), true);
  });

  it("lets a send the user rejected be tried again, but not one the wallet may have sent", async () => {
    const seeding = october();
    const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const retry = seedingSession(fakeWallet(seeding, { send: rejected }), seeding);
    await retry.check();
    await assert.rejects(retry.send(), /User rejected/);
    assert.deepEqual([retry.canCheck(), retry.canSend()], [true, false]);
    await retry.check();
    assert.equal(retry.canSend(), true);

    for (const send of [new Error("Device disconnected"), null]) {
      const session = seedingSession(fakeWallet(seeding, { send }), seeding);
      await session.check();
      await assert.rejects(session.send());
      assert.deepEqual([session.canCheck(), session.canSend()], [false, false], String(send));
    }
  });

  it("waits for the seeding to be mined, and reads the week's root at that block", async () => {
    const seeding = october();
    const sleep = async () => {};
    const mined = { status: "0x1", blockNumber: "0x1918f00" };
    const wallet = fakeWallet(seeding, {
      receipts: [null, null, mined],
      answers: { "weekMerkleRoots(68)": OCTOBER.root },
    });
    assert.equal(await waitForSeeding(wallet, seeding, HASH, { sleep }), 0x1918f00);
    assert.equal(wallet.calls.filter(({ method }) => method === "eth_getTransactionReceipt").length, 3);
    assert.equal(wallet.calls.at(-1).params[1], "0x1918f00");

    const reverted = fakeWallet(seeding, { receipts: [{ status: "0x0", blockNumber: "0x10" }] });
    await assert.rejects(waitForSeeding(reverted, seeding, HASH, { sleep }), /mined in block 16, and reverted/);
    const otherRoot = fakeWallet(seeding, { receipts: [mined], answers: { "weekMerkleRoots(68)": word("22") } });
    await assert.rejects(waitForSeeding(otherRoot, seeding, HASH, { sleep }), /week 68's root is 0x0+22/);
  });
});

describe("seeding page server", () => {
  const get = (port, path, { host = `127.0.0.1:${port}`, method = "GET" } = {}) =>
    new Promise((resolve, reject) => {
      const outgoing = request(
        { host: "127.0.0.1", port, path, method, headers: { host }, agent: false },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() })
          );
        }
      );
      outgoing.on("error", reject);
      outgoing.end();
    });

  it("serves the page and its modules to requests addressed to this machine, and nothing else", async () => {
    const server = createSignerServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const page = await get(port, new URL(OCTOBER_LINK).pathname + new URL(OCTOBER_LINK).search);
      assert.equal(page.status, 200);
      assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(page.headers["content-security-policy"], "frame-ancestors 'none'");
      assert.equal(page.headers["x-frame-options"], "DENY");
      assert.equal(page.body, readFileSync(new URL("../src/signer/index.html", import.meta.url), "utf8"));
      const module = await get(port, "/seed.js", { host: `localhost:${port}` });
      assert.equal(module.status, 200);
      assert.equal(module.headers["content-type"], "text/javascript; charset=utf-8");
      assert.equal(module.body, readFileSync(new URL("../src/signer/seed.js", import.meta.url), "utf8"));
      // the chains, from config.js, as the module the page imports
      const chains = await get(port, "/chains.js");
      assert.equal(chains.status, 200);
      assert.equal(chains.headers["content-type"], "text/javascript; charset=utf-8");
      assert.deepEqual(
        (await import(`data:text/javascript,${encodeURIComponent(chains.body)}`)).SEED_CHAINS,
        SEED_CHAINS
      );

      for (const path of [
        "/index.html",
        "/server.js",
        "/../config.js",
        "/%2e%2e/config.js",
        "//seed.js",
        "/seed.js/",
      ]) {
        assert.equal((await get(port, path)).status, 404, path);
      }
      assert.equal((await get(port, "/", { host: `evil.example:${port}` })).status, 404);
      assert.equal((await get(port, "/", { host: "127.0.0.1" })).status, 404);
      assert.equal((await get(port, "/", { method: "POST" })).status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("is listened on at 127.0.0.1 only, by sign.js", () => {
    assert.match(
      readFileSync(new URL("../sign.js", import.meta.url), "utf8"),
      /\.listen\(SIGNER_PORT, "127\.0\.0\.1",/
    );
  });
});
