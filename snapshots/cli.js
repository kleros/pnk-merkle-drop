#!/usr/bin/env node
import dotenv from "dotenv";
import { BigNumber, getDefaultProvider, utils } from "ethers";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import { createSnapshotCreator } from "./src/create-snapshot.js";
import storeSnapshot from "./src/store-snapshot.js";
import bigNumberJsonReplacer from "./src/helpers/big-number-json-replacer.js";

dotenv.config();

dayjs.extend(utc);

const etherscanApiKey = process.env.PNK_DROP_ETHERSCAN_API_KEY;
const alchemyApiKey = process.env.PNK_DROP_ALCHEMY_API_KEY;

const argv = yargs(hideBin(process.argv))
  .env("PNK_DROP")
  .strict(true)
  .locale("en")
  .usage(
    `Usage: $0 --amount={n} --period={n} --kleros-liquid-address={s} --chain-id={n} -- start-date={YYYY-MM-DD} --end-date={YYYY-MM-DD}`
  )
  .epilogue("Alternatively you can set the same params in the .env file. Check .env.example.")
  .option("amount", {
    description: "The amount of tokens being distributed",
  })
  .option("period", {
    description: "The numeric period ID of the distribution",
  })
  .option("start-date", {
    description: "The start date to start collecting the balances [YYYY-MM-DD]",
  })
  .option("end-date", {
    description: "The end date to stop collecting the balances [YYYY-MM-DD]",
  })
  .option("kleros-liquid-address", {
    description: "The KlerosLiquid address",
  })
  .option("chain-id", {
    description: "The chain ID as a decimal number",
  })
  .option("save", {
    description:
      "If false, instead of submitting the snapshot to the S3 bucket, it will output the content to the screen",
    default: true,
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
  .demand(["kleros-liquid-address", "period", "amount", "chain-id", "start-date", "end-date"])
  .boolean(["no-save"])
  .string(["kleros-liquid-address", "infura-api-key", "etherscan-api-key", "alchemy-api-key"])
  .number(["chain=id", "from-block", "to-block"])
  .coerce(["amount"], (value) => utils.parseEther(String(value)))
  .coerce(["start-date"], (value) => dayjs.utc(value).startOf("day"))
  .coerce(["end-date"], (value) => dayjs.utc(value).endOf("day")).argv;

const throwError = (err) => {
  throw err;
};

const normalizeArgs = ({ amount, startDate, endDate, ...rest }) => ({
  amount: BigNumber.from(String(amount)),
  startDate: startDate.isValid() ? startDate : throwError(new Error("Invalid start date")),
  endDate: endDate.isValid() ? endDate : throwError(new Error("Invalid end date")),
  ...rest,
});

const {
  save,
  chainId,
  klerosLiquidAddress,
  amount,
  period,
  startDate,
  endDate,
  fromBlock,
  infuraApiKey,
} = normalizeArgs(argv);

endDate.isBefore(startDate) && throwError(new Error("End date cannot be before start date"));

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
    const snapshot = await createSnapshot({ fromBlock, startDate, endDate });

    if (save) {
      const url = await storeSnapshot({ chainId, period, content: snapshot });
      console.log(url);
    } else {
      console.log(JSON.stringify(snapshot, bigNumberJsonReplacer, 2));
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
