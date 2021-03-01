#!/usr/bin/env node
import dotenv from "dotenv";
import { BigNumber, getDefaultProvider, utils } from "ethers";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import { createSnapshotCreator } from "./src/create-snapshot.js";
import { storeOnIpfs, storeOnLocalCache, storeOnS3 } from "./src/store-snapshot.js";

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
    description: "The start date (inclusive) to start collecting the balances [YYYY-MM-DD]",
  })
  .option("end-date", {
    description: "The end date (exclusive) to stop collecting the balances [YYYY-MM-DD]",
  })
  .option("kleros-liquid-address", {
    description: "The KlerosLiquid address",
  })
  .option("chain-id", {
    description: "The chain ID as a decimal number",
  })
  .option("save-s3", {
    description: "Submit the snapshot to the S3 bucket",
    default: false,
  })
  .option("save-ipfs", {
    description: "Submit the snapshot to IPFS",
    default: false,
  })
  .option("save-local", {
    description: "Save the snapshot to a local file inside .cache",
    default: false,
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
  .boolean(["save-s3", "save-local", "save-ipfs"])
  .string(["kleros-liquid-address", "infura-api-key", "etherscan-api-key", "alchemy-api-key"])
  .number(["chain-id", "from-block", "to-block"])
  .coerce(["amount"], (value) => utils.parseEther(String(value)))
  .coerce(["start-date"], (value) => dayjs.utc(value).startOf("day"))
  .coerce(["end-date"], (value) => dayjs.utc(value).startOf("day")).argv;

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
  saveS3,
  saveLocal,
  saveIpfs,
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

    if (saveS3) {
      const s3Url = await storeOnS3({ chainId, period, content: snapshot });
      console.info("Stored on S3:");
      console.info(s3Url);
    }

    if (saveIpfs) {
      const ipfsPath = await storeOnIpfs({ chainId, period, content: snapshot });
      console.info("Stored on IPFS:");
      console.info(ipfsPath);
    }

    if (saveLocal || (!saveS3 && !saveIpfs)) {
      const filePath = await storeOnLocalCache({ chainId, period, content: snapshot });
      console.info("Stored on local cache:");
      console.info(filePath);
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
