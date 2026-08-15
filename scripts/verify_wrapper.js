const { ethers } = require("hardhat");

const ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

const TOKENS = {
  wTSLAx: "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171",
  wSPYx: "0xe7e553cd128f0011777323a0b44a7b96ea1cb540",
};

async function verifyWrapper(label, address) {
  console.log(`\n=== ${label} (${address}) ===`);
  const contract = await ethers.getContractAt(ABI, address);

  try {
    const [name, symbol] = await Promise.all([contract.name(), contract.symbol()]);
    console.log(`name(): ${name}`);
    console.log(`symbol(): ${symbol}`);
  } catch (e) {
    console.log(`name()/symbol() call failed: ${e.message}`);
  }

  let baseAsset;
  try {
    baseAsset = await contract.asset();
    console.log(`asset(): ${baseAsset}`);
  } catch (e) {
    console.log(`asset() call failed - NOT an ERC-4626 wrapper, or wrong ABI: ${e.message}`);
    return;
  }

  const [totalAssets, totalSupply] = await Promise.all([contract.totalAssets(), contract.totalSupply()]);
  console.log(`totalAssets(): ${totalAssets.toString()}`);
  console.log(`totalSupply(): ${totalSupply.toString()}`);

  const oneShare = ethers.parseUnits("1", 18);
  const assetsForOneShare = await contract.convertToAssets(oneShare);
  const rate = Number(assetsForOneShare) / Number(oneShare);
  console.log(`convertToAssets(1e18): ${assetsForOneShare.toString()}`);
  console.log(`Implied exchange rate: ${rate}`);

  if (rate === 1.0) {
    console.log("WARNING: Exchange rate is exactly 1.0 - no accrual detected.");
  } else {
    console.log("OK: Non-trivial exchange rate confirmed - consistent with section 9.10.");
  }
}

async function main() {
  for (const [label, address] of Object.entries(TOKENS)) {
    await verifyWrapper(label, address);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
