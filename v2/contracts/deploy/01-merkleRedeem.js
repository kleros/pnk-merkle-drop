const paramsByChainId = {
  42161: {
    pnkAddress: "0x330bD769382cFc6d50175903434CCC8D206DCAE5",
  }
};

module.exports = async function deployMerkleRedeem({ deployments, getNamedAccounts, getChainId }) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const chainId = await getChainId();
  const { pnkAddress } = paramsByChainId[chainId];

  const merkleRedeem = await deploy("MerkleRedeemV2", {
    from: deployer,
    gas: 8000000,
    args: [pnkAddress],
  });

  console.log("Deployed to:", merkleRedeem.address);
};
