import dotenv from "dotenv";
import { getDefaultProvider } from "ethers";
import { fileURLToPath } from "url";

// The live tests read the chains through the RPC URLs a run uses, from snapshots/.env.
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const RPC_ENV = { 1: "ALCHEMY_ETH_MAINNET_RPC", 100: "ALCHEMY_GNOSIS_RPC", 42161: "ALCHEMY_ARB_ONE_RPC" };
for (const name of Object.values(RPC_ENV)) {
  if (!process.env[name]) throw new Error(`The live tests need ${name} in snapshots/.env, see .env.example`);
}

export const providers = Object.fromEntries(
  Object.entries(RPC_ENV).map(([chainId, name]) => [chainId, getDefaultProvider(process.env[name])])
);
