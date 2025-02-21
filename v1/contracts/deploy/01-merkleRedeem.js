const paramsByChainId = {
  42: {
    pnkAddress: "0x1EE318dBC19267dBCE08F54A66ab198F73EdE356",
  },
  1: {
    pnkAddress: "0x93ED3FBe21207Ec2E8f2d3c3de6e058Cb73Bc04d",
  },
  100: {
    pnkAddress: "0xcb3231aBA3b451343e0Fddfc45883c842f223846",
  },
};

module.exports = async function deployMerkleRedeem({ deployments, getNamedAccounts, getChainId }) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const chainId = await getChainId();
  const { pnkAddress } = paramsByChainId[chainId];

  const merkleRedeem = await deploy("MerkleRedeem", {
    from: deployer,
    gas: 8000000,
    args: [pnkAddress],
  });

  console.log("Deployed to:", merkleRedeem.address);
};
