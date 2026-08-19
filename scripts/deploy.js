// Parallax deployment script.
//
// Deploys the four-contract stack in dependency order and performs every
// post-deploy wiring step, then reads the resulting on-chain state back to
// confirm the wiring actually took effect.
//
// USAGE
//   1. cp scripts/deploy.config.example.js scripts/deploy.config.js
//   2. Fill in every field that the example marks NOT YET VERIFIED.
//   3. npx hardhat run scripts/deploy.js --network <xlayer|xlayerTestnet>
//
// This file contains NO addresses and NO tuning parameters. Everything comes
// from the config object, per this project's standing rule against hardcoding
// values that belong in configuration (docs/parallax_litepaper.md §9.3 states
// that rule for asset-class mappings; the same discipline applies here).
//
// The deployment sequence lives in `deployStack()` rather than in `main()` so
// that test/Deployment.test.js can drive THIS function against mock
// dependencies. That matters: a test that reimplemented the sequence would
// verify its own copy and prove nothing about what actually runs on a real
// network.

const { ethers } = require("hardhat");

/// RiskLegManager.AssetClass — NONE = 0 is the unset sentinel and is never a
/// valid configured value, so it is deliberately absent from this map.
const ASSET_CLASS = {
  crypto: 1,
  equity: 2,
};

/// Every config field that must be non-null before a real-network deploy.
/// Nested paths use dots; `assets[]` entries are validated per-element.
const REQUIRED_TOP_LEVEL = ["usdc", "aavePool", "uniswapV3SwapRouter", "riskServiceSigner"];
const REQUIRED_VAULT = ["depositCap", "conservativeRateBps", "minimumDeposit", "earlyExitPenaltyBps"];
const REQUIRED_ASSET = [
  "ticker",
  "class",
  "address",
  "decimals",
  "poolFeeTier",
  "chainlinkAggregator",
  "maxStalenessSeconds",
];

/// @returns {string[]} human-readable descriptions of everything unusable.
///          Empty array means the config is complete.
///
/// Collects ALL problems rather than throwing on the first. Deploying is a
/// one-shot operation against a live network, so the operator should see the
/// full list of what to research in one pass instead of discovering fields one
/// failed run at a time.
function validateConfig(config) {
  const problems = [];

  if (!config || typeof config !== "object") {
    return ["config is not an object — did scripts/deploy.config.js export something?"];
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (config[key] === null || config[key] === undefined) {
      problems.push(`${key} is ${config[key] === undefined ? "missing" : "null"} — NOT YET VERIFIED`);
    }
  }

  if (!config.vault || typeof config.vault !== "object") {
    problems.push("vault block is missing");
  } else {
    for (const key of REQUIRED_VAULT) {
      if (config.vault[key] === null || config.vault[key] === undefined) {
        problems.push(`vault.${key} is ${config.vault[key] === undefined ? "missing" : "null"}`);
      }
    }
  }

  if (!Array.isArray(config.assets) || config.assets.length === 0) {
    problems.push("assets[] is missing or empty");
    return problems;
  }

  const seenTickers = new Set();
  const seenAddresses = new Set();

  config.assets.forEach((asset, i) => {
    const label = asset && asset.ticker ? asset.ticker : `assets[${i}]`;

    for (const key of REQUIRED_ASSET) {
      if (!asset || asset[key] === null || asset[key] === undefined) {
        problems.push(`${label}.${key} is ${asset && asset[key] === null ? "null" : "missing"} — NOT YET VERIFIED`);
      }
    }
    if (!asset) return;

    if (asset.class !== null && asset.class !== undefined && !(asset.class in ASSET_CLASS)) {
      problems.push(
        `${label}.class is "${asset.class}" — must be one of: ${Object.keys(ASSET_CLASS).join(", ")}`
      );
    }

    // §10.6 lookalike-token discipline: the whitelist is address-keyed, so a
    // duplicated address would silently collapse two universe entries into one
    // whitelist slot, and a duplicated ticker would make the deploy log
    // ambiguous about which asset was configured.
    if (asset.ticker) {
      if (seenTickers.has(asset.ticker)) problems.push(`duplicate ticker: ${asset.ticker}`);
      seenTickers.add(asset.ticker);
    }
    if (asset.address) {
      const normalized = String(asset.address).toLowerCase();
      if (seenAddresses.has(normalized)) problems.push(`duplicate address: ${asset.address}`);
      seenAddresses.add(normalized);

      if (!ethers.isAddress(asset.address)) {
        problems.push(`${label}.address is not a valid address: ${asset.address}`);
      }
    }
    if (asset.chainlinkAggregator && !ethers.isAddress(asset.chainlinkAggregator)) {
      problems.push(`${label}.chainlinkAggregator is not a valid address: ${asset.chainlinkAggregator}`);
    }
    if (asset.decimals === 0) {
      // RiskLegManager uses 0 as its "not configured" sentinel and rejects it.
      problems.push(`${label}.decimals is 0 — RiskLegManager treats 0 as unconfigured and will revert`);
    }
    if (asset.poolFeeTier === 0) {
      problems.push(`${label}.poolFeeTier is 0 — not a valid Uniswap V3 tier; RiskLegManager will revert`);
    }
  });

  for (const key of REQUIRED_TOP_LEVEL) {
    const value = config[key];
    if (value && !ethers.isAddress(value)) {
      problems.push(`${key} is not a valid address: ${value}`);
    }
  }

  return problems;
}

/// Deploys the stack and performs all wiring. Assumes `config` already passed
/// validateConfig() — callers that skip that get whatever the contracts do.
///
/// @param config  resolved deployment config (see deploy.config.example.js)
/// @param options.signer  deployer; defaults to Hardhat's first signer
/// @param options.log     line logger; pass () => {} to silence
/// @returns deployed contract instances plus their addresses
async function deployStack(config, options = {}) {
  const log = options.log || ((...args) => console.log(...args));
  const signer = options.signer || (await ethers.getSigners())[0];

  log(`Deployer: ${await signer.getAddress()}`);
  log("");

  // -- 1. OracleConsumer (no dependencies) -------------------------------
  log("[1/8] OracleConsumer");
  const OracleConsumer = await ethers.getContractFactory("OracleConsumer", signer);
  const oracleConsumer = await OracleConsumer.deploy();
  await oracleConsumer.waitForDeployment();
  const oracleConsumerAddress = await oracleConsumer.getAddress();
  log(`      -> ${oracleConsumerAddress}`);

  // -- 2. SafeLegManager (usdc, aavePool) -------------------------------
  log("[2/8] SafeLegManager");
  const SafeLegManager = await ethers.getContractFactory("SafeLegManager", signer);
  const safeLegManager = await SafeLegManager.deploy(config.usdc, config.aavePool);
  await safeLegManager.waitForDeployment();
  const safeLegManagerAddress = await safeLegManager.getAddress();
  log(`      -> ${safeLegManagerAddress}`);

  // -- 3. RiskLegManager (usdc, router, oracle from step 1) -------------
  log("[3/8] RiskLegManager");
  const RiskLegManager = await ethers.getContractFactory("RiskLegManager", signer);
  const riskLegManager = await RiskLegManager.deploy(
    config.usdc,
    config.uniswapV3SwapRouter,
    oracleConsumerAddress
  );
  await riskLegManager.waitForDeployment();
  const riskLegManagerAddress = await riskLegManager.getAddress();
  log(`      -> ${riskLegManagerAddress}`);

  // -- 4. ParallaxVault (usdc, both managers, tuning params) ------------
  log("[4/8] ParallaxVault");
  const ParallaxVault = await ethers.getContractFactory("ParallaxVault", signer);
  const vault = await ParallaxVault.deploy(
    config.usdc,
    safeLegManagerAddress,
    riskLegManagerAddress,
    config.vault.depositCap,
    config.vault.conservativeRateBps,
    config.vault.minimumDeposit,
    config.vault.earlyExitPenaltyBps
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  log(`      -> ${vaultAddress}`);
  log("");

  // -- 5/6. One-time vault wiring --------------------------------------
  //
  // Both setVault calls revert if called twice, by design — a re-settable
  // trusted caller would let the owner redirect fund flows post-deployment
  // (see SafeLegManager.setVault's doc comment). A re-run of this script
  // against already-deployed managers will therefore fail here rather than
  // silently rewire, which is the safe failure.
  log("[5/8] SafeLegManager.setVault");
  await (await safeLegManager.setVault(vaultAddress)).wait();

  log("[6/8] RiskLegManager.setVault");
  await (await riskLegManager.setVault(vaultAddress)).wait();

  // -- 7. Risk-service signer (§9.8) -----------------------------------
  log("[7/8] RiskLegManager.setRiskServiceSigner");
  await (await riskLegManager.setRiskServiceSigner(config.riskServiceSigner)).wait();

  // -- 8. Per-asset configuration --------------------------------------
  log(`[8/8] Configuring ${config.assets.length} assets`);
  for (const asset of config.assets) {
    const classId = ASSET_CLASS[asset.class];

    await (await riskLegManager.configureAsset(asset.address, true, classId)).wait();
    await (
      await riskLegManager.configureAssetSwapMetadata(asset.address, asset.decimals, asset.poolFeeTier)
    ).wait();
    await (
      await oracleConsumer.configureFeed(
        asset.address,
        asset.chainlinkAggregator,
        asset.maxStalenessSeconds
      )
    ).wait();

    log(
      `      ${asset.ticker.padEnd(8)} ${asset.address}  class=${asset.class} ` +
        `decimals=${asset.decimals} feeTier=${asset.poolFeeTier} staleness=${asset.maxStalenessSeconds}s`
    );
  }

  return {
    oracleConsumer,
    safeLegManager,
    riskLegManager,
    vault,
    addresses: {
      oracleConsumer: oracleConsumerAddress,
      safeLegManager: safeLegManagerAddress,
      riskLegManager: riskLegManagerAddress,
      vault: vaultAddress,
    },
  };
}

/// Reads deployed state back and returns a list of anything that does not match
/// the config. Separate from deployStack so it can also be run against an
/// existing deployment as an audit.
///
/// This is a genuine post-condition check, not decoration: steps 5-8 are ~18
/// separate transactions on a real network, and a partially-applied wiring
/// (say, one asset's feed missing) would otherwise surface much later as a
/// confusing revert inside a rebalance.
async function verifyWiring(deployed, config) {
  const problems = [];
  const { oracleConsumer, safeLegManager, riskLegManager, addresses } = deployed;

  const safeVault = await safeLegManager.vault();
  if (safeVault !== addresses.vault) {
    problems.push(`SafeLegManager.vault() is ${safeVault}, expected ${addresses.vault}`);
  }

  const riskVault = await riskLegManager.vault();
  if (riskVault !== addresses.vault) {
    problems.push(`RiskLegManager.vault() is ${riskVault}, expected ${addresses.vault}`);
  }

  const signer = await riskLegManager.riskServiceSigner();
  if (signer.toLowerCase() !== String(config.riskServiceSigner).toLowerCase()) {
    problems.push(`RiskLegManager.riskServiceSigner() is ${signer}, expected ${config.riskServiceSigner}`);
  }

  const oracleOnManager = await riskLegManager.oracleConsumer();
  if (oracleOnManager !== addresses.oracleConsumer) {
    problems.push(
      `RiskLegManager.oracleConsumer() is ${oracleOnManager}, expected ${addresses.oracleConsumer}`
    );
  }

  for (const asset of config.assets) {
    if (!(await riskLegManager.assetWhitelisted(asset.address))) {
      problems.push(`${asset.ticker}: not whitelisted`);
    }

    const onChainClass = await riskLegManager.assetClass(asset.address);
    if (Number(onChainClass) !== ASSET_CLASS[asset.class]) {
      problems.push(`${asset.ticker}: class is ${onChainClass}, expected ${ASSET_CLASS[asset.class]}`);
    }

    const onChainDecimals = await riskLegManager.assetDecimals(asset.address);
    if (Number(onChainDecimals) !== Number(asset.decimals)) {
      problems.push(`${asset.ticker}: decimals is ${onChainDecimals}, expected ${asset.decimals}`);
    }

    const onChainFeeTier = await riskLegManager.poolFeeTier(asset.address);
    if (Number(onChainFeeTier) !== Number(asset.poolFeeTier)) {
      problems.push(`${asset.ticker}: poolFeeTier is ${onChainFeeTier}, expected ${asset.poolFeeTier}`);
    }

    const feed = await oracleConsumer.feeds(asset.address);
    if (feed.aggregator.toLowerCase() !== String(asset.chainlinkAggregator).toLowerCase()) {
      problems.push(
        `${asset.ticker}: feed aggregator is ${feed.aggregator}, expected ${asset.chainlinkAggregator}`
      );
    }
    if (Number(feed.maxStalenessSeconds) !== Number(asset.maxStalenessSeconds)) {
      problems.push(
        `${asset.ticker}: feed maxStalenessSeconds is ${feed.maxStalenessSeconds}, ` +
          `expected ${asset.maxStalenessSeconds}`
      );
    }
  }

  return problems;
}

function loadConfig() {
  try {
    // eslint-disable-next-line global-require
    return require("./deploy.config.js");
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && /deploy\.config/.test(e.message)) {
      throw new Error(
        "scripts/deploy.config.js not found.\n" +
          "  Create it from the template:  cp scripts/deploy.config.example.js scripts/deploy.config.js\n" +
          "  Then fill in every field the template marks NOT YET VERIFIED."
      );
    }
    throw e;
  }
}

async function main() {
  const config = loadConfig();

  const problems = validateConfig(config);
  if (problems.length > 0) {
    console.error("Deployment config is incomplete. Refusing to deploy.\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nEvery field above must be filled with a value confirmed against a primary source.\n" +
        "Do NOT substitute a plausible-looking address to get past this check — an unverified\n" +
        "address would pass validation and route real funds (same reasoning as the header note\n" +
        "in offchain/config/asset_universe.yaml)."
    );
    process.exitCode = 1;
    return;
  }

  const network = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (chainId ${network.chainId})`);
  if (config.network && config.network.chainId && Number(config.network.chainId) !== Number(network.chainId)) {
    console.error(
      `\nRefusing to deploy: config expects chainId ${config.network.chainId}, connected to ${network.chainId}.`
    );
    process.exitCode = 1;
    return;
  }
  console.log("");

  const deployed = await deployStack(config);

  console.log("\nVerifying wiring...");
  const wiringProblems = await verifyWiring(deployed, config);
  if (wiringProblems.length > 0) {
    console.error("\nWIRING VERIFICATION FAILED:");
    for (const problem of wiringProblems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("All wiring verified.\n");

  console.log("Deployed addresses:");
  for (const [name, address] of Object.entries(deployed.addresses)) {
    console.log(`  ${name.padEnd(18)} ${address}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { deployStack, verifyWiring, validateConfig, loadConfig, ASSET_CLASS };
