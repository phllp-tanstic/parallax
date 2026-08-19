const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployStack, verifyWiring, validateConfig, ASSET_CLASS } = require("../scripts/deploy.js");

// Dry-run of the real deployment script against MOCK dependencies.
//
// WHY THIS IS A TEST FILE rather than a standalone script: it must be
// re-runnable and it must fail CI if the deployment sequence breaks. A
// script under scripts/ only runs when someone remembers to run it, and a
// deployment sequence that silently rots is exactly the thing that surfaces
// during a live deploy instead of before one.
//
// WHAT THIS PROVES: the deploy ORDER and WIRING logic are correct — each
// contract gets its dependencies, both one-time setVault calls land, the
// risk-service signer is set, and all five assets are configured across both
// RiskLegManager and OracleConsumer. It then issues a real note to confirm the
// four contracts are wired to EACH OTHER, not merely individually deployable.
//
// WHAT THIS DOES NOT PROVE: that any real X Layer address is correct. Every
// dependency here is a mock, deliberately — the real Aave pool, Uniswap router,
// and Chainlink aggregator addresses are unverified open items (see
// scripts/deploy.config.example.js). This file is the part of the deployment
// that CAN be proven today; the rest is blocked on research, not on code.
describe("Deployment (local dry-run against mocks)", function () {
  const USDC_DECIMALS = 6;
  const FEED_DECIMALS = 8;
  const usdcAmount = (n) => ethers.parseUnits(n.toString(), USDC_DECIMALS);

  // Mirrors the five-asset MVP universe of
  // offchain/config/asset_universe.yaml (§13: "2-3 xStocks + 1-2 crypto").
  //
  // Addresses are NOT used here — each asset gets a freshly deployed MockERC20,
  // because the point is to exercise the wiring, and pointing at real addresses
  // on a local network would just be pointing at empty accounts. decimals /
  // feeTier / staleness / price below are TEST VALUES chosen to span a range,
  // NOT claims about the real assets; the real ones are unverified open items.
  const ASSETS = [
    { ticker: "BTC-USD", class: "crypto", decimals: 8, poolFeeTier: 500, maxStalenessSeconds: 3600, price: 60_000 },
    { ticker: "ETH-USD", class: "crypto", decimals: 18, poolFeeTier: 500, maxStalenessSeconds: 3600, price: 3_000 },
    { ticker: "wNVDAx", class: "equity", decimals: 18, poolFeeTier: 3000, maxStalenessSeconds: 86_400, price: 180 },
    { ticker: "wTSLAx", class: "equity", decimals: 18, poolFeeTier: 3000, maxStalenessSeconds: 86_400, price: 420 },
    { ticker: "wSPYx", class: "equity", decimals: 6, poolFeeTier: 3000, maxStalenessSeconds: 86_400, price: 550 },
  ];

  const VAULT_PARAMS = {
    depositCap: usdcAmount(1_000_000).toString(),
    conservativeRateBps: 500,
    minimumDeposit: usdcAmount(10).toString(),
    earlyExitPenaltyBps: 500,
  };

  /// Stands up mock dependencies and builds the config object that deploy.js
  /// consumes, then runs the real deployStack() against it.
  async function deployFixture() {
    const [deployer, riskServiceSigner, alice] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);

    const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
    const aavePool = await MockAaveV3Pool.deploy();

    const MockUniswapV3Router = await ethers.getContractFactory("MockUniswapV3Router");
    const swapRouter = await MockUniswapV3Router.deploy();

    const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
    const now = (await ethers.provider.getBlock("latest")).timestamp;

    const tokens = {};
    const aggregators = {};
    const assets = [];

    for (const spec of ASSETS) {
      const token = await MockERC20.deploy(spec.ticker, spec.ticker, spec.decimals);
      const aggregator = await MockChainlinkAggregator.deploy(FEED_DECIMALS);
      await aggregator.setLatestAnswer(ethers.parseUnits(spec.price.toString(), FEED_DECIMALS), now);

      tokens[spec.ticker] = token;
      aggregators[spec.ticker] = aggregator;

      assets.push({
        ticker: spec.ticker,
        class: spec.class,
        address: await token.getAddress(),
        decimals: spec.decimals,
        poolFeeTier: spec.poolFeeTier,
        chainlinkAggregator: await aggregator.getAddress(),
        maxStalenessSeconds: spec.maxStalenessSeconds,
      });
    }

    const config = {
      usdc: await usdc.getAddress(),
      aavePool: await aavePool.getAddress(),
      uniswapV3SwapRouter: await swapRouter.getAddress(),
      riskServiceSigner: riskServiceSigner.address,
      vault: { ...VAULT_PARAMS },
      assets,
    };

    // The deployment under test is the real exported function, not a copy.
    const deployed = await deployStack(config, { signer: deployer, log: () => {} });

    return { deployed, config, usdc, aavePool, swapRouter, tokens, aggregators, deployer, riskServiceSigner, alice };
  }

  // -------------------------------------------------------------------------
  // Config validation — the guard that stops an unverified deploy
  // -------------------------------------------------------------------------

  describe("validateConfig", function () {
    /// A structurally complete config, used as the baseline that each case below
    /// breaks in exactly one way.
    function completeConfig() {
      const addr = (n) => ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(n), 20));
      return {
        usdc: addr(1),
        aavePool: addr(2),
        uniswapV3SwapRouter: addr(3),
        riskServiceSigner: addr(4),
        vault: { ...VAULT_PARAMS },
        assets: ASSETS.map((spec, i) => ({
          ticker: spec.ticker,
          class: spec.class,
          address: addr(100 + i),
          decimals: spec.decimals,
          poolFeeTier: spec.poolFeeTier,
          chainlinkAggregator: addr(200 + i),
          maxStalenessSeconds: spec.maxStalenessSeconds,
        })),
      };
    }

    it("accepts a fully populated config", function () {
      expect(validateConfig(completeConfig())).to.deep.equal([]);
    });

    it("reports every null top-level field rather than only the first", function () {
      const config = completeConfig();
      config.aavePool = null;
      config.uniswapV3SwapRouter = null;

      const problems = validateConfig(config);
      // Both must appear: a deploy operator should get the whole research list
      // in one pass, not discover fields one failed run at a time.
      expect(problems.some((p) => p.includes("aavePool"))).to.equal(true);
      expect(problems.some((p) => p.includes("uniswapV3SwapRouter"))).to.equal(true);
    });

    it("rejects a null per-asset chainlinkAggregator", function () {
      const config = completeConfig();
      config.assets[2].chainlinkAggregator = null;

      const problems = validateConfig(config);
      expect(problems.some((p) => p.includes("wNVDAx.chainlinkAggregator"))).to.equal(true);
    });

    it("rejects a null per-asset maxStalenessSeconds and poolFeeTier", function () {
      const config = completeConfig();
      config.assets[0].maxStalenessSeconds = null;
      config.assets[1].poolFeeTier = null;

      const problems = validateConfig(config);
      expect(problems.some((p) => p.includes("BTC-USD.maxStalenessSeconds"))).to.equal(true);
      expect(problems.some((p) => p.includes("ETH-USD.poolFeeTier"))).to.equal(true);
    });

    it("rejects the example config as-is — it must not be deployable unmodified", function () {
      // The template ships with unverified fields null on purpose. If this ever
      // passes, someone filled the template with guessed values.
      // eslint-disable-next-line global-require
      const example = require("../scripts/deploy.config.example.js");
      expect(validateConfig(example).length).to.be.greaterThan(0);
    });

    it("rejects decimals of 0 and feeTier of 0, which the contracts treat as unconfigured", function () {
      const config = completeConfig();
      config.assets[0].decimals = 0;
      config.assets[1].poolFeeTier = 0;

      const problems = validateConfig(config);
      expect(problems.some((p) => p.includes("decimals is 0"))).to.equal(true);
      expect(problems.some((p) => p.includes("poolFeeTier is 0"))).to.equal(true);
    });

    it("rejects an unknown asset class", function () {
      const config = completeConfig();
      config.assets[0].class = "commodity";

      expect(validateConfig(config).some((p) => p.includes('class is "commodity"'))).to.equal(true);
    });

    it("rejects a duplicated asset address — §10.6 whitelist is address-keyed", function () {
      const config = completeConfig();
      config.assets[1].address = config.assets[0].address;

      expect(validateConfig(config).some((p) => p.includes("duplicate address"))).to.equal(true);
    });

    it("rejects a malformed address", function () {
      const config = completeConfig();
      config.assets[0].address = "0xnot-an-address";

      expect(validateConfig(config).some((p) => p.includes("not a valid address"))).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Deployment order and wiring
  // -------------------------------------------------------------------------

  describe("deployStack", function () {
    it("deploys all four contracts to distinct, non-zero addresses", async function () {
      const { deployed } = await loadFixture(deployFixture);
      const values = Object.values(deployed.addresses);

      for (const [name, address] of Object.entries(deployed.addresses)) {
        expect(address, name).to.properAddress;
        expect(address, name).to.not.equal(ethers.ZeroAddress);
      }
      expect(new Set(values).size).to.equal(4);
    });

    it("passes each contract its dependencies from the config, and the oracle from step 1", async function () {
      const { deployed, config } = await loadFixture(deployFixture);
      const { safeLegManager, riskLegManager, vault, addresses } = deployed;

      expect(await safeLegManager.usdc()).to.equal(config.usdc);
      expect(await safeLegManager.aavePool()).to.equal(config.aavePool);

      expect(await riskLegManager.usdc()).to.equal(config.usdc);
      expect(await riskLegManager.swapRouter()).to.equal(config.uniswapV3SwapRouter);
      // The dependency that makes ordering matter: step 3 consumes step 1.
      expect(await riskLegManager.oracleConsumer()).to.equal(addresses.oracleConsumer);

      expect(await vault.usdc()).to.equal(config.usdc);
      expect(await vault.safeLegManager()).to.equal(addresses.safeLegManager);
      expect(await vault.riskLegManager()).to.equal(addresses.riskLegManager);
    });

    it("applies the vault tuning parameters from config", async function () {
      const { deployed } = await loadFixture(deployFixture);
      const { vault } = deployed;

      expect(await vault.depositCap()).to.equal(VAULT_PARAMS.depositCap);
      expect(await vault.conservativeRateBps()).to.equal(VAULT_PARAMS.conservativeRateBps);
      expect(await vault.minimumDeposit()).to.equal(VAULT_PARAMS.minimumDeposit);
      expect(await vault.earlyExitPenaltyBps()).to.equal(VAULT_PARAMS.earlyExitPenaltyBps);
    });

    it("completes both one-time setVault wirings and the risk-service signer", async function () {
      const { deployed, config } = await loadFixture(deployFixture);
      const { safeLegManager, riskLegManager, addresses } = deployed;

      expect(await safeLegManager.vault()).to.equal(addresses.vault);
      expect(await riskLegManager.vault()).to.equal(addresses.vault);
      expect(await riskLegManager.riskServiceSigner()).to.equal(config.riskServiceSigner);
    });

    it("configures all five assets on BOTH RiskLegManager and OracleConsumer", async function () {
      const { deployed, config } = await loadFixture(deployFixture);
      const { riskLegManager, oracleConsumer } = deployed;

      expect(config.assets.length).to.equal(5);

      for (const asset of config.assets) {
        expect(await riskLegManager.assetWhitelisted(asset.address), `${asset.ticker} whitelisted`).to.equal(true);
        expect(Number(await riskLegManager.assetClass(asset.address)), `${asset.ticker} class`).to.equal(
          ASSET_CLASS[asset.class]
        );
        expect(Number(await riskLegManager.assetDecimals(asset.address)), `${asset.ticker} decimals`).to.equal(
          asset.decimals
        );
        expect(Number(await riskLegManager.poolFeeTier(asset.address)), `${asset.ticker} feeTier`).to.equal(
          asset.poolFeeTier
        );

        const feed = await oracleConsumer.feeds(asset.address);
        expect(feed.aggregator, `${asset.ticker} aggregator`).to.equal(asset.chainlinkAggregator);
        expect(Number(feed.maxStalenessSeconds), `${asset.ticker} staleness`).to.equal(asset.maxStalenessSeconds);
      }
    });

    it("configures the crypto/equity split the MVP universe specifies (§13: 2 crypto, 3 equity)", async function () {
      const { deployed, config } = await loadFixture(deployFixture);
      const { riskLegManager } = deployed;

      let crypto = 0;
      let equity = 0;
      for (const asset of config.assets) {
        const cls = Number(await riskLegManager.assetClass(asset.address));
        if (cls === ASSET_CLASS.crypto) crypto++;
        if (cls === ASSET_CLASS.equity) equity++;
      }

      // Both classes must be non-empty or §9.3's 10% per-class diversification
      // floor is unsatisfiable and every allocation would fall back (§9.3.1).
      expect(crypto).to.equal(2);
      expect(equity).to.equal(3);
    });

    it("leaves the oracle priced and readable for every configured asset", async function () {
      const { deployed, config } = await loadFixture(deployFixture);
      const { oracleConsumer } = deployed;

      for (const asset of config.assets) {
        expect(await oracleConsumer.isFresh(asset.address), `${asset.ticker} fresh`).to.equal(true);
        expect(await oracleConsumer.getPrice(asset.address), `${asset.ticker} price`).to.be.gt(0);
      }
    });

    it("verifyWiring reports no problems against the deployed stack", async function () {
      const { deployed, config } = await loadFixture(deployFixture);
      expect(await verifyWiring(deployed, config)).to.deep.equal([]);
    });

    it("verifyWiring DETECTS a wiring mismatch — the check is not vacuous", async function () {
      const { deployed, config } = await loadFixture(deployFixture);

      // Claim a different signer than what was actually set. If verifyWiring
      // returned [] here too, the assertion above would be worthless.
      const tampered = { ...config, riskServiceSigner: ethers.ZeroAddress };
      const problems = await verifyWiring(deployed, tampered);

      expect(problems.some((p) => p.includes("riskServiceSigner"))).to.equal(true);
    });

    it("cannot be re-wired: setVault reverts on a second call, closing the redirect vector", async function () {
      const { deployed, alice } = await loadFixture(deployFixture);
      const { safeLegManager, riskLegManager } = deployed;

      await expect(safeLegManager.setVault(alice.address)).to.be.revertedWithCustomError(
        safeLegManager,
        "VaultAlreadySet"
      );
      await expect(riskLegManager.setVault(alice.address)).to.be.revertedWithCustomError(
        riskLegManager,
        "VaultAlreadySet"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Smoke test — proves the four contracts are wired to EACH OTHER
  // -------------------------------------------------------------------------

  describe("smoke test: issue one note end-to-end", function () {
    it("issues a note and records the §9.1 safe-leg/risk-leg split", async function () {
      const { deployed, usdc, alice } = await loadFixture(deployFixture);
      const { vault } = deployed;

      const principal = usdcAmount(10_000);
      await usdc.mint(alice.address, principal);
      await usdc.connect(alice).approve(await vault.getAddress(), principal);

      await expect(vault.connect(alice).issueNote(principal)).to.emit(vault, "NoteIssued");

      const note = await vault.getNote(0);

      expect(note.owner).to.equal(alice.address);
      expect(note.principal).to.equal(principal);
      expect(note.redeemed).to.equal(false);

      // §9.1 with t=1 and r=5%: safe = principal * 10000 / 10500.
      // $10,000 -> $9,523.809523 safe, $476.190477 risk.
      const expectedSafeLeg = (principal * 10_000n) / (10_000n + BigInt(VAULT_PARAMS.conservativeRateBps));
      expect(note.safeLegAmount).to.equal(expectedSafeLeg);
      expect(note.riskLegAmount).to.equal(principal - expectedSafeLeg);

      // The invariant that matters: the split accounts for the whole deposit.
      expect(note.safeLegAmount + note.riskLegAmount).to.equal(principal);

      expect(note.maturesAt - note.issuedAt).to.equal(365n * 24n * 60n * 60n);
    });

    it("routes the safe leg into Aave and the risk leg into RiskLegManager", async function () {
      const { deployed, usdc, aavePool, alice } = await loadFixture(deployFixture);
      const { vault, safeLegManager, riskLegManager } = deployed;

      const principal = usdcAmount(10_000);
      await usdc.mint(alice.address, principal);
      await usdc.connect(alice).approve(await vault.getAddress(), principal);
      await vault.connect(alice).issueNote(principal);

      const note = await vault.getNote(0);

      // Both legs must be visible through the managers' own accounting — this
      // is what a set of individually-deployable-but-unwired contracts would
      // fail. The vault's own record agreeing with itself would prove nothing.
      expect(await safeLegManager.getSafeLegValue(0)).to.equal(note.safeLegAmount);
      expect(await riskLegManager.getRiskLegValue(0)).to.equal(note.riskLegAmount);

      // And the USDC physically moved: the safe leg is in the Aave mock, the
      // risk leg sits as idle USDC in RiskLegManager awaiting a §9.3 allocation.
      expect(await usdc.balanceOf(await aavePool.getAddress())).to.equal(note.safeLegAmount);
      expect(await usdc.balanceOf(await riskLegManager.getAddress())).to.equal(note.riskLegAmount);

      // Nothing stranded in the vault itself.
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0);
    });

    it("tracks totalDeposited against the cap across two notes", async function () {
      const { deployed, usdc, alice } = await loadFixture(deployFixture);
      const { vault } = deployed;

      const principal = usdcAmount(10_000);
      await usdc.mint(alice.address, principal * 2n);
      await usdc.connect(alice).approve(await vault.getAddress(), principal * 2n);

      await vault.connect(alice).issueNote(principal);
      await vault.connect(alice).issueNote(principal);

      expect(await vault.totalDeposited()).to.equal(principal * 2n);
      expect(await vault.getNote(1)).to.not.be.undefined;
    });
  });
});
