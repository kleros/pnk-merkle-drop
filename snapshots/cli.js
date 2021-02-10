#!/usr/bin/env node
import dotenv from "dotenv";
import { BigNumber, getDefaultProvider, utils } from "ethers";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createSnapshotCreator } from "./src/create-snapshot.js";
import storeSnapshot from "./src/store-snapshot.js";

dotenv.config();

const etherscanApiKey = process.env.PNK_DROP_ETHERSCAN_API_KEY;
const alchemyApiKey = process.env.PNK_DROP_ALCHEMY_API_KEY;

const argv = yargs(hideBin(process.argv))
  .env("PNK_DROP")
  .strict(true)
  .locale("en")
  .usage(`Usage: $0 --amount={n} --period={n} --kleros-liquid-address={s} --chain-id={n}`)
  .epilogue("Alternatively you can set the same params in the .env file. Check .env.example.")
  .option("amount", {
    description: "The amount of tokens being distributed",
  })
  .option("period", {
    description: "The numeric period ID of the distribution",
  })
  .option("kleros-liquid-address", {
    description: "The KlerosLiquid address",
  })
  .option("chain-id", {
    description: "The chain ID as a decimal number",
  })
  .option("from-block", {
    description: "The block to start querying events from",
  })
  .option("to-block", {
    description: "The block to end the query for events",
  })
  .option("infura-api-key", {
    description: "The Infura API key",
  })
  .option("etherscan-api-key", {
    description: "The Etherscan API key",
  })
  .option("alchemy-api-key", {
    description: "The Alchemy API key",
  })
  .option("h", {
    alias: "help",
  })
  .option("V", {
    alias: "version",
  })
  .demand(["kleros-liquid-address", "period", "amount", "chain-id"])
  .string(["kleros-liquid-address", "infura-api-key", "etherscan-api-key", "alchemy-api-key"])
  .number(["chain=id", "from-block", "to-block"])
  .coerce(["amount"], (value) => utils.parseEther(String(value))).argv;

const normalizeArgs = ({ amount, ...rest }) => ({
  amount: BigNumber.from(String(amount)),
  ...rest,
});

const { chainId, klerosLiquidAddress, amount, period, fromBlock, infuraApiKey } = normalizeArgs(argv);

const provider = getDefaultProvider(chainId, {
  etherscan: etherscanApiKey,
  alchemy: alchemyApiKey,
  infura: infuraApiKey,
});

(async () => {
  try {
    const createSnapshot = await createSnapshotCreator({
      provider,
      klerosLiquidAddress,
      droppedAmount: amount,
    });
    const snapshot = await createSnapshot({ fromBlock });
    const url = await storeSnapshot({ chainId, period, content: snapshot });
    console.log(url);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
