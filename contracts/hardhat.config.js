require("dotenv-safe/config");
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("hardhat-deploy");
require("hardhat-deploy-ethers");

module.exports = {
  solidity: {
    version: "0.6.8",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./src",
  },
  networks: {
    hardhat: {
      live: false,
      saveDeployments: false,
      tags: ["test", "local"],
    },
    kovan: {
      chainId: 42,
      url: `https://kovan.infura.io/v3/${process.env.INFURA_API_KEY}`,
      accounts: [process.env.DEPLOYER_PRIVATE_KEY],
      live: true,
      saveDeployments: true,
      tags: ["staging"],
    },
    mainnet: {
      chainId: 1,
      url: `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      accounts: [process.env.PRODUCTION_DEPLOYER_PRIVATE_KEY],
      live: true,
      saveDeployments: true,
      tags: ["production"],
    },
    xdai: {
      chainId: 100,
      url: "https://rpc.xdaichain.com",
      accounts: [process.env.PRODUCTION_DEPLOYER_PRIVATE_KEY],
      live: true,
      saveDeployments: true,
      tags: ["production"],
    },
  },
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
};
