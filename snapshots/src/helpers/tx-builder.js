import fs from "fs";

// Transaction batch example: https://github.com/safe-global/safe-wallet-monorepo/blob/8bbf3b82edc347b70a038629cd9afd45eb1ed38a/apps/web/cypress/fixtures/test-working-batch.json

const signer = "0x28A81EC3045F079DCf051BA2F3280335D18144cC";
const transactions = [];

export const createNewBatch = () => {
  transactions.length = 0;
};

const template = ({ name, chainId, safeAddress, transactions }) => ({
  version: "1.0",
  chainId,
  createdAt: Date.now(),
  meta: {
    name,
    description: "", // Not used because the Safe app doesn't show it
    txBuilderVersion: "1.18.0",
    createdFromSafeAddress: safeAddress,
    createdFromOwnerAddress: signer,
  },
  transactions,
});

const transaction = ({ to, value, data }) => ({
  to,
  value: value?.toString() ?? "0",
  data,
  contractMethod: null,
  contractInputsValues: null,
});

const transactionBuilderUrl = ({ chainShortName, safeAddress }) =>
  `https://app.safe.global/apps/open?safe=${chainShortName}:${safeAddress}&appUrl=https%3A%2F%2Fapps-portal.safe.global%2Ftx-builder`;

export const addTransactionToBatch = (tx) => {
  const { to, value, data } = tx;
  transactions.push(transaction({ to, value, data }));
  console.log("tx = %O", tx);
};

export function writeTransactionBatch({ name, chainId, chainShortName, safeAddress, outputPath = "tx-batch.json" }) {
  if (!name?.trim()) throw new Error("Batch name is required");

  if (!transactions?.length) {
    console.log("No transaction batch to write");
    return;
  }

  try {
    const templateObject = template({ name, chainId, safeAddress, transactions });
    fs.writeFileSync(outputPath, JSON.stringify(templateObject, null, 2));
    console.log(`Transaction batch written to ${outputPath}`);
    console.log(
      `The batch can be submitted to the Safe app at: ${transactionBuilderUrl({ chainShortName, safeAddress })}`
    );
  } catch (error) {
    throw new Error(`Failed to write transaction batch: ${error.message}`);
  }
}