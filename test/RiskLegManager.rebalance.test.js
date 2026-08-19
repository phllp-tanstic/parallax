const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("RiskLegManager — rebalance decision layer (§9.3/§9.5/§9.6/§9.8)", function () {
  const CONTRACT_NAME = "ParallaxRiskLegManager";
  const CONTRACT_VERSION = "1";
  const AssetClass = { NONE: 0, CRYPTO: 1, EQUITY: 2 };

  const USDC_DECIMALS = 6;
  const FEED_DECIMALS = 8; // standard Chainlink USD-pair decimals
  const MAX_STALENESS = 3600; // arbitrary test value, NOT a production
                              // recommendation — see §9.9
  const DEFAULT_MAX_SLIPPAGE_BPS = 200n; // the contract's unvalidated default,
                                          // asserted here so a change to it
                                          // fails loudly rather than silently
                                          // shifting every expectation below
  const BPS = 10_000n;
  const MIN_LIQUIDITY_FLOOR_BPS = 1_000n; // HardBounds.MIN_LIQUIDITY_FLOOR_BPS

  const usdcAmount = (n) => ethers.parseUnits(n.toString(), USDC_DECIMALS);

  // Token decimals here are TEST VALUES chosen to span the 6/8/18 range so the
  // decimal-scaling math in valueInUsdc / _usdcValueToTokenAmount is actually
  // exercised in both directions. They are not claims about the real decimals
  // of any specific X Layer asset.
  const ASSETS = [
    { key: "btc", name: "Wrapped BTC", symbol: "WBTC", decimals: 8, price: 60_000, feeTier: 500, class: AssetClass.CRYPTO },
    { key: "eth", name: "Wrapped ETH", symbol: "WETH", decimals: 18, price: 3_000, feeTier: 500, class: AssetClass.CRYPTO },
    { key: "nvda", name: "NVDA xStock", symbol: "wNVDAx", decimals: 18, price: 180, feeTier: 3_000, class: AssetClass.EQUITY },
    { key: "spy", name: "SPY xStock", symbol: "wSPYx", decimals: 6, price: 550, feeTier: 3_000, class: AssetClass.EQUITY },
  ];

  function makeAddress(seed) {
    return ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(seed), 20));
  }

  /// Configures the mock router to fill BOTH directions of asset/USDC at
  /// exactly the oracle-implied fair rate, so any deviation a test observes is
  /// caused by the contract's own arithmetic or by an explicitly-set haircut —
  /// never by the mock quietly disagreeing with the oracle.
  ///
  ///   asset -> USDC:  out = in * priceRaw / 10^(tokenDecimals + feedDecimals - 6)
  ///   USDC -> asset:  out = in * 10^(tokenDecimals + feedDecimals - 6) / priceRaw
  ///
  /// which is exactly valueInUsdc() and its inverse.
  async function setFairRates(router, usdcAddress, assetAddress, tokenDecimals, price) {
    const priceRaw = ethers.parseUnits(price.toString(), FEED_DECIMALS);
    const scale = 10n ** (BigInt(tokenDecimals) + BigInt(FEED_DECIMALS) - BigInt(USDC_DECIMALS));

    await router.setRate(assetAddress, usdcAddress, priceRaw, scale);
    await router.setRate(usdcAddress, assetAddress, scale, priceRaw);
  }

  async function deployFixture() {
    const [owner, riskServiceSigner, otherSigner, vaultSigner] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    const usdcAddress = await usdc.getAddress();

    const MockUniswapV3Router = await ethers.getContractFactory("MockUniswapV3Router");
    const swapRouter = await MockUniswapV3Router.deploy();
    const routerAddress = await swapRouter.getAddress();

    const OracleConsumer = await ethers.getContractFactory("OracleConsumer");
    const oracle = await OracleConsumer.deploy();

    const RiskLegManager = await ethers.getContractFactory("RiskLegManager");
    const manager = await RiskLegManager.deploy(usdcAddress, routerAddress, await oracle.getAddress());

    await manager.connect(owner).setVault(vaultSigner.address);
    await manager.connect(owner).setRiskServiceSigner(riskServiceSigner.address);

    const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
    const now = (await ethers.provider.getBlock("latest")).timestamp;

    // Real ERC20s, real feeds, real router liquidity for every asset. Previously
    // these were fabricated non-contract addresses, which was sufficient while
    // _executeAllocation only recorded state — it now reads balances and swaps,
    // so the assets have to actually exist.
    const tokens = {};
    const aggregators = {};
    const addresses = {};

    for (const spec of ASSETS) {
      const token = await MockERC20.deploy(spec.name, spec.symbol, spec.decimals);
      const address = await token.getAddress();

      const aggregator = await MockChainlinkAggregator.deploy(FEED_DECIMALS);
      await oracle
        .connect(owner)
        .configureFeed(address, await aggregator.getAddress(), MAX_STALENESS);
      await aggregator.setLatestAnswer(ethers.parseUnits(spec.price.toString(), FEED_DECIMALS), now);

      await manager.connect(owner).configureAsset(address, true, spec.class);
      await manager.connect(owner).configureAssetSwapMetadata(address, spec.decimals, spec.feeTier);

      await setFairRates(swapRouter, usdcAddress, address, spec.decimals, spec.price);

      // Fund the router so it can actually deliver either side of a swap.
      await token.mint(routerAddress, ethers.parseUnits("1000000", spec.decimals));

      tokens[spec.key] = token;
      aggregators[spec.key] = aggregator;
      addresses[spec.key] = address;
    }

    await usdc.mint(routerAddress, usdcAmount(100_000_000));

    // Vault-side funding, so tests that need the pool to actually hold capital
    // can deposit through the real onlyVault path.
    await usdc.mint(vaultSigner.address, usdcAmount(10_000_000));
    await usdc.connect(vaultSigner).approve(await manager.getAddress(), ethers.MaxUint256);

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: CONTRACT_NAME,
      version: CONTRACT_VERSION,
      chainId,
      verifyingContract: await manager.getAddress(),
    };
    const types = {
      SignedAllocation: [
        { name: "assets", type: "address[]" },
        { name: "weights", type: "uint256[]" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    return {
      manager, usdc, swapRouter, oracle, owner, riskServiceSigner, otherSigner, vaultSigner,
      btc: addresses.btc, eth: addresses.eth, nvda: addresses.nvda, spy: addresses.spy,
      btcToken: tokens.btc, ethToken: tokens.eth, nvdaToken: tokens.nvda, spyToken: tokens.spy,
      btcFeed: aggregators.btc, ethFeed: aggregators.eth, nvdaFeed: aggregators.nvda, spyFeed: aggregators.spy,
      tokens, aggregators, domain, types,
    };
  }

  async function futureExpiry(offsetSeconds = 3600) {
    const latest = await time.latest();
    return BigInt(latest + offsetSeconds);
  }

  async function signAllocation(signer, domain, types, allocation) {
    return signer.signTypedData(domain, types, allocation);
  }

  describe("configureAsset", function () {
    it("only owner can configure an asset", async function () {
      const { manager, otherSigner, btc } = await loadFixture(deployFixture);
      await expect(
        manager.connect(otherSigner).configureAsset(btc, true, AssetClass.CRYPTO)
      ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
    });

    it("emits AssetConfigured with correct values", async function () {
      const { manager, owner } = await loadFixture(deployFixture);
      const newAsset = makeAddress(999);
      await expect(manager.connect(owner).configureAsset(newAsset, true, AssetClass.EQUITY))
        .to.emit(manager, "AssetConfigured")
        .withArgs(newAsset, true, AssetClass.EQUITY);
    });

    it("can de-whitelist a previously whitelisted asset", async function () {
      const { manager, owner, btc } = await loadFixture(deployFixture);
      await manager.connect(owner).configureAsset(btc, false, AssetClass.CRYPTO);
      expect(await manager.assetWhitelisted(btc)).to.equal(false);
    });
  });

  describe("setRiskServiceSigner", function () {
    it("only owner can set the signer", async function () {
      const { manager, otherSigner } = await loadFixture(deployFixture);
      await expect(
        manager.connect(otherSigner).setRiskServiceSigner(otherSigner.address)
      ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
    });

    it("emits RiskServiceSignerUpdated", async function () {
      const { manager, owner, riskServiceSigner, otherSigner } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setRiskServiceSigner(otherSigner.address))
        .to.emit(manager, "RiskServiceSignerUpdated")
        .withArgs(riskServiceSigner.address, otherSigner.address);
    });
  });

  describe("submitRebalanceTarget — signature and bounds verification", function () {
    it("accepts a validly-signed, in-bounds allocation from the correct signer (bootstrap)", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);

      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.not.be.reverted;
      expect(await manager.allocationNonce()).to.equal(1n);
    });

    it("rejects a signature from a non-authorized signer", async function () {
      const { manager, otherSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(otherSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "InvalidSignature"
      );
    });

    it("rejects a valid signature if the allocation payload is tampered after signing", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const original = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, original);
      const tampered = { ...original, weights: [3000n, 7000n] };

      await expect(manager.submitRebalanceTarget(tampered, signature)).to.be.revertedWithCustomError(
        manager, "InvalidSignature"
      );
    });

    it("rejects an expired allocation", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: 1n };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "ExpiredAllocation"
      );
    });

    it("rejects a nonce that doesn't match the expected next value", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 5n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "InvalidNonce"
      );
    });

    it("rejects replay of the exact same allocation + signature after it was already consumed", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await manager.submitRebalanceTarget(allocation, signature);
      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "InvalidNonce"
      );
    });

    it("rejects an allocation containing a non-whitelisted asset", async function () {
      const { manager, riskServiceSigner, btc, domain, types } = await loadFixture(deployFixture);
      const unlisted = makeAddress(666);
      const allocation = { assets: [btc, unlisted], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "UnwhitelistedAsset"
      );
    });

    it("rejects an allocation where any single weight exceeds the 60% concentration cap", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [6001n, 3999n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "ConcentrationCapExceeded"
      );
    });

    it("rejects an allocation whose weights don't sum to 10000 bps", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 5000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "WeightsDoNotSumToOne"
      );
    });

    it("rejects an allocation where a single asset moves more than 20pp from its previous weight", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [2000n, 4000n, 4000n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // btc 20% -> 45%: a 25pp move, exceeds the cap. nvda/spy absorb the
      // rest, each moving only 12.5pp, well within bounds.
      const second = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, second);

      await expect(manager.submitRebalanceTarget(second, signature)).to.be.revertedWithCustomError(
        manager, "MaxDeltaExceeded"
      );
    });

    it("accepts an allocation at exactly the 20pp delta boundary", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [2000n, 4000n, 4000n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // btc 20% -> 40%: exactly a 20pp move (boundary, must pass).
      const second = { assets: [btc, nvda, spy], weights: [4000n, 3000n, 3000n], nonce: 1n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, second);

      await expect(manager.submitRebalanceTarget(second, signature)).to.not.be.reverted;
    });
  });

  describe("De-risk / re-risk classification", function () {
    it("executes IMMEDIATELY on the first-ever (bootstrap) allocation, regardless of crypto weight", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [3000n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, nvda, spy], [3000n, 3500n, 3500n], false);
    });

    it("executes IMMEDIATELY when crypto weight decreases (clear de-risk) after a prior allocation exists", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [3000n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // Crypto 30% -> 20%: decrease, de-risk, immediate.
      const second = { assets: [btc, nvda, spy], weights: [2000n, 4000n, 4000n], nonce: 1n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(second, await signAllocation(riskServiceSigner, domain, types, second))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, nvda, spy], [2000n, 4000n, 4000n], false);
    });

    it("does NOT execute immediately when crypto weight increases after a prior allocation exists (re-risk) — records a pending signal instead", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [3000n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // Crypto 30% -> 45%: increase, re-risk. Should NOT execute yet.
      const second = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(second, await signAllocation(riskServiceSigner, domain, types, second))
      )
        .to.emit(manager, "ReRiskSignalRecorded")
        .and.to.not.emit(manager, "RebalanceExecuted");

      const [, weights] = await manager.getCurrentAllocation();
      expect(weights).to.deep.equal([3000n, 3500n, 3500n]);

      const pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(true);
    });

    it("aggregates crypto weight correctly across MULTIPLE crypto assets, not just one", async function () {
      const { manager, riskServiceSigner, btc, eth, nvda, spy, domain, types } = await loadFixture(deployFixture);

      // Baseline: btc 15% + eth 15% = 30% total crypto.
      const first = { assets: [btc, eth, nvda, spy], weights: [1500n, 1500n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // New: btc 10% + eth 10% = 20% total crypto (DOWN from 30%) — total
      // crypto decreased even though both individual assets moved, so this
      // must classify as de-risk and execute immediately.
      const second = { assets: [btc, eth, nvda, spy], weights: [1000n, 1000n, 4000n, 4000n], nonce: 1n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(second, await signAllocation(riskServiceSigner, domain, types, second))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, eth, nvda, spy], [1000n, 1000n, 4000n, 4000n], false);
    });
  });

  describe("Re-risk confirmation delay (§9.6)", function () {
    async function establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types) {
      const baseline = { assets: [btc, nvda, spy], weights: [3000n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(baseline, await signAllocation(riskServiceSigner, domain, types, baseline));
    }

    it("does not execute a re-risk signal before 5 days have passed", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);
      await establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types);

      const reRisk = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(reRisk, await signAllocation(riskServiceSigner, domain, types, reRisk));

      await time.increase(4 * 24 * 60 * 60);

      const secondSubmission = { ...reRisk, nonce: 2n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(
          secondSubmission,
          await signAllocation(riskServiceSigner, domain, types, secondSubmission)
        )
      ).to.not.emit(manager, "RebalanceExecuted");

      const pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(true);
    });

    it("executes at exactly 5 days with FRESH target weights, not the stale day-1 weights", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);
      await establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types);

      const day1 = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      const day1Tx = await manager.submitRebalanceTarget(day1, await signAllocation(riskServiceSigner, domain, types, day1));
      const day1Receipt = await day1Tx.wait();
      const day1Block = await ethers.provider.getBlock(day1Receipt.blockNumber);

      const fiveDays = 5 * 24 * 60 * 60;
      await time.increaseTo(day1Block.timestamp + fiveDays);

      // Day 5: fresher weights — 50% crypto, not day 1's 45%. Also exactly
      // a 20pp delta from baseline (30% -> 50%), the boundary case.
      const day5 = { assets: [btc, nvda, spy], weights: [5000n, 2500n, 2500n], nonce: 2n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(day5, await signAllocation(riskServiceSigner, domain, types, day5))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, nvda, spy], [5000n, 2500n, 2500n], true);

      const [, weights] = await manager.getCurrentAllocation();
      expect(weights).to.deep.equal([5000n, 2500n, 2500n]);

      const pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(false);
    });

    it("a whipsaw (re-risk reversed to de-risk before 5 days) clears the pending signal without executing the re-risk", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);
      await establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types);

      const day1 = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(day1, await signAllocation(riskServiceSigner, domain, types, day1));

      let pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(true);

      await time.increase(2 * 24 * 60 * 60);

      // Reverses below the baseline (30% -> 20%) — a clear de-risk relative
      // to the last EXECUTED allocation, not the pending (never-executed) one.
      const whipsaw = { assets: [btc, nvda, spy], weights: [2000n, 4000n, 4000n], nonce: 2n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(whipsaw, await signAllocation(riskServiceSigner, domain, types, whipsaw))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, nvda, spy], [2000n, 4000n, 4000n], false);

      pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(false);
    });

    it("nonce still advances even while a re-risk signal is only being recorded, not executed", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);
      await establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types);

      const reRisk = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(reRisk, await signAllocation(riskServiceSigner, domain, types, reRisk));

      expect(await manager.allocationNonce()).to.equal(2n);
    });
  });

  // =========================================================================
  // EXECUTION LAYER — real swaps via IUniswapV3Router
  //
  // Everything above exercises the DECISION layer against an empty pool, where
  // totalValue == 0 and both rebalance passes are skipped by design. Everything
  // below funds the pool first, so _executeAllocation actually trades.
  // =========================================================================

  /// Deposits through the real onlyVault path so share state is consistent with
  /// what a live vault would produce.
  async function depositToPool(manager, vaultSigner, noteId, amount) {
    await manager.connect(vaultSigner).depositRiskLeg(noteId, amount);
  }

  async function submit(manager, riskServiceSigner, domain, types, assets, weights, nonce) {
    const allocation = { assets, weights, nonce, expiry: await futureExpiry() };
    return manager.submitRebalanceTarget(
      allocation,
      await signAllocation(riskServiceSigner, domain, types, allocation)
    );
  }

  /// The §9.8 invariant, computed from ACTUAL post-execution balances rather
  /// than from the contract's own view helper — so a bug in the contract's
  /// valuation cannot make this check agree with itself.
  async function usdcShareBps(manager, usdc) {
    const managerAddress = await manager.getAddress();
    const usdcBalance = await usdc.balanceOf(managerAddress);
    const totalValue = await manager.totalPoolValue();
    return (usdcBalance * BPS) / totalValue;
  }

  describe("configureAssetSwapMetadata", function () {
    it("only owner can configure swap metadata", async function () {
      const { manager, otherSigner, btc } = await loadFixture(deployFixture);
      await expect(
        manager.connect(otherSigner).configureAssetSwapMetadata(btc, 8, 500)
      ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero decimals — 0 is the not-configured sentinel", async function () {
      const { manager, owner, btc } = await loadFixture(deployFixture);
      await expect(
        manager.connect(owner).configureAssetSwapMetadata(btc, 0, 500)
      ).to.be.revertedWithCustomError(manager, "InvalidAssetDecimals");
    });

    it("reverts on zero fee tier — 0 is not a valid V3 tier", async function () {
      const { manager, owner, btc } = await loadFixture(deployFixture);
      await expect(
        manager.connect(owner).configureAssetSwapMetadata(btc, 8, 0)
      ).to.be.revertedWithCustomError(manager, "InvalidPoolFeeTier");
    });

    it("stores both values and emits AssetSwapMetadataConfigured", async function () {
      const { manager, owner } = await loadFixture(deployFixture);
      const asset = makeAddress(4242);

      await expect(manager.connect(owner).configureAssetSwapMetadata(asset, 18, 10_000))
        .to.emit(manager, "AssetSwapMetadataConfigured")
        .withArgs(asset, 18, 10_000);

      expect(await manager.assetDecimals(asset)).to.equal(18);
      expect(await manager.poolFeeTier(asset)).to.equal(10_000);
    });

    it("rejects an allocation naming a whitelisted asset that has no swap metadata", async function () {
      const { manager, owner, riskServiceSigner, nvda, domain, types } = await loadFixture(deployFixture);

      // Whitelisted (so it clears the §9.8 whitelist bound) but never given
      // decimals or a fee tier — the contract must refuse to allocate into
      // something it cannot value or unwind, rather than swap against a
      // fee-tier-0 pool that does not exist.
      const unconfigured = makeAddress(777);
      await manager.connect(owner).configureAsset(unconfigured, true, AssetClass.CRYPTO);

      await expect(
        submit(manager, riskServiceSigner, domain, types, [unconfigured, nvda], [4000n, 6000n], 0n)
      ).to.be.revertedWithCustomError(manager, "SwapMetadataNotConfigured");
    });
  });

  describe("setMaxSlippageBps", function () {
    it("defaults to the contract's disclosed-unvalidated 200 bps", async function () {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.maxSlippageBps()).to.equal(DEFAULT_MAX_SLIPPAGE_BPS);
    });

    it("only owner can set it", async function () {
      const { manager, otherSigner } = await loadFixture(deployFixture);
      await expect(
        manager.connect(otherSigner).setMaxSlippageBps(300)
      ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
    });

    it("emits MaxSlippageBpsUpdated with old and new values", async function () {
      const { manager, owner } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setMaxSlippageBps(350))
        .to.emit(manager, "MaxSlippageBpsUpdated")
        .withArgs(DEFAULT_MAX_SLIPPAGE_BPS, 350n);
      expect(await manager.maxSlippageBps()).to.equal(350n);
    });

    it("rejects 10000 bps, which would disable slippage protection entirely", async function () {
      const { manager, owner } = await loadFixture(deployFixture);
      await expect(
        manager.connect(owner).setMaxSlippageBps(10_000)
      ).to.be.revertedWithCustomError(manager, "InvalidMaxSlippageBps");
    });

    it("accepts 9999 bps — no tighter bound is imposed, deliberately (see contract doc)", async function () {
      const { manager, owner } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setMaxSlippageBps(9_999)).to.not.be.reverted;
    });
  });

  describe("Buy pass — deploying idle USDC into the target allocation", function () {
    it("buys each asset to its floor-scaled target, with exactly-computed amounts", async function () {
      const { manager, usdc, swapRouter, riskServiceSigner, vaultSigner, btc, nvda, btcToken, nvdaToken, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      const managerAddress = await manager.getAddress();

      // deployable      = 100,000 * 9000/10000 = 90,000 USDC
      // btc  target     =  90,000 * 4000/10000 = 36,000 USDC -> 0.6 BTC @ $60,000
      // nvda target     =  90,000 * 6000/10000 = 54,000 USDC -> 300 NVDA @ $180
      expect(await btcToken.balanceOf(managerAddress)).to.equal(ethers.parseUnits("0.6", 8));
      expect(await nvdaToken.balanceOf(managerAddress)).to.equal(ethers.parseUnits("300", 18));

      // 10,000 USDC retained — the §9.8 floor, reserved by construction.
      expect(await usdc.balanceOf(managerAddress)).to.equal(usdcAmount(10_000));
      expect(await swapRouter.swapCount()).to.equal(2n);
    });

    it("leaves post-execution USDC at exactly the §9.8 floor, never below it, from weights that sum to 10000 among risky assets alone", async function () {
      const { manager, usdc, riskServiceSigner, vaultSigner, btc, nvda, spy, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(250_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda, spy], [3000n, 3500n, 3500n], 0n);

      const bps = await usdcShareBps(manager, usdc);

      expect(bps).to.be.gte(MIN_LIQUIDITY_FLOOR_BPS);
      expect(bps).to.equal(MIN_LIQUIDITY_FLOOR_BPS); // reserved exactly, not approximately
    });

    it("holds the floor across a range of deposit sizes and weight splits", async function () {
      const { manager, usdc, riskServiceSigner, vaultSigner, btc, eth, nvda, spy, domain, types } =
        await loadFixture(deployFixture);

      // Deliberately awkward splits and a non-round deposit, so the assertion
      // is not passing on tidy numbers that happen to divide evenly.
      await depositToPool(manager, vaultSigner, 0, usdcAmount("33333.333333"));
      await submit(
        manager, riskServiceSigner, domain, types,
        [btc, eth, nvda, spy], [1111n, 2222n, 3333n, 3334n], 0n
      );

      expect(await usdcShareBps(manager, usdc)).to.be.gte(MIN_LIQUIDITY_FLOOR_BPS);
    });

    it("derives amountOutMinimum from the ORACLE price and the slippage tolerance, not from the pool", async function () {
      const { manager, swapRouter, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      // Last swap of the pass is nvda: 54,000 USDC -> 300 NVDA at the oracle
      // price, floored at (10000 - 200)/10000 of that.
      const fairOut = ethers.parseUnits("300", 18);
      const lastSwap = await swapRouter.lastSwap();

      expect(lastSwap.amountOutMinimum).to.equal((fairOut * (BPS - DEFAULT_MAX_SLIPPAGE_BPS)) / BPS);
      expect(lastSwap.amountOut).to.equal(fairOut);
    });

    it("passes the target asset's own configured pool fee tier (nvda -> 3000)", async function () {
      const { manager, swapRouter, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));

      // Last swap of the pass is nvda, configured at tier 3000.
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);
      expect((await swapRouter.lastSwap()).fee).to.equal(3000);
    });

    it("passes a DIFFERENT asset's tier when that asset is the one swapped (btc -> 500)", async function () {
      const { manager, swapRouter, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));

      // Same pair, order reversed, so btc is now the LAST swap — it must pick
      // up 500, not nvda's 3000. Two tiers observed from two orderings is what
      // proves the lookup is per-asset rather than one global value; asserting
      // only the first case would pass even against a hardcoded 3000.
      //
      // Deliberately a fresh fixture rather than a second submit on the
      // previous one: after a rebalance the portfolio is already at target, so
      // a re-submit executes no swaps and `lastSwap` would still hold the
      // earlier nvda swap — a stale read that looks like a real assertion.
      await submit(manager, riskServiceSigner, domain, types, [nvda, btc], [6000n, 4000n], 0n);
      expect((await swapRouter.lastSwap()).fee).to.equal(500);
    });

    it("sets amountOutMinimum equal to the oracle-fair amount when slippage tolerance is zero", async function () {
      const { manager, owner, swapRouter, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await manager.connect(owner).setMaxSlippageBps(0);
      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      const lastSwap = await swapRouter.lastSwap();
      expect(lastSwap.amountOutMinimum).to.equal(ethers.parseUnits("300", 18));
    });

    it("routes swap output to the manager itself, never to an external recipient", async function () {
      const { manager, swapRouter, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      expect((await swapRouter.lastSwap()).recipient).to.equal(await manager.getAddress());
    });

    it("leaves no standing router allowance after a rebalance", async function () {
      const { manager, usdc, swapRouter, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      expect(await usdc.allowance(await manager.getAddress(), await swapRouter.getAddress())).to.equal(0);
    });

    it("refuses a swap whose oracle-expected output rounds to zero, rather than spending USDC for nothing", async function () {
      const { manager, usdc, swapRouter, riskServiceSigner, vaultSigner, btc, spy, btcToken, spyToken, domain, types } =
        await loadFixture(deployFixture);

      // One unit of btc (8dp @ $60,000) is worth 600 USDC-units; one unit of spy
      // (6dp @ $550) is worth 550. A 1,000-unit ($0.001) deposit therefore
      // produces targets of 450 units each — below one output unit for both, so
      // the oracle expects ZERO tokens from either trade.
      //
      // Why this matters beyond wasted gas: amountOutMinimum is a FRACTION of
      // the expected output, so a zero expectation yields a zero minimum, and a
      // swap with a zero minimum is unprotected — the router could take the
      // input and return nothing while still satisfying it. Without the guard
      // these two trades spend 900 of the 1,000 units and receive nothing.
      const deposit = 1_000n;
      await depositToPool(manager, vaultSigner, 0, deposit);

      await submit(manager, riskServiceSigner, domain, types, [btc, spy], [5000n, 5000n], 0n);

      const managerAddress = await manager.getAddress();
      expect(await swapRouter.swapCount()).to.equal(0n);
      expect(await usdc.balanceOf(managerAddress)).to.equal(deposit); // nothing spent
      expect(await btcToken.balanceOf(managerAddress)).to.equal(0);
      expect(await spyToken.balanceOf(managerAddress)).to.equal(0);
    });

    it("skips only the zero-output leg, still executing the legs that can produce output", async function () {
      const { manager, usdc, swapRouter, riskServiceSigner, vaultSigner, btc, nvda, btcToken, nvdaToken, domain, types } =
        await loadFixture(deployFixture);

      // Same 1,000-unit deposit, but paired with nvda (18dp @ $180), whose
      // single unit is worth ~1.8e-16 USD — never dust. btc's 400-unit target
      // rounds to zero output and is skipped; nvda's 540-unit target converts
      // cleanly and executes. Proves the guard is per-swap, not an all-or-nothing
      // bail-out of the whole pass.
      await depositToPool(manager, vaultSigner, 0, 1_000n);
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      const managerAddress = await manager.getAddress();
      expect(await swapRouter.swapCount()).to.equal(1n);
      expect(await btcToken.balanceOf(managerAddress)).to.equal(0);
      expect(await nvdaToken.balanceOf(managerAddress)).to.equal(3_000_000_000_000n); // 540 USDC / $180
      expect(await usdc.balanceOf(managerAddress)).to.equal(460n);
      expect(await usdcShareBps(manager, usdc)).to.be.gte(MIN_LIQUIDITY_FLOOR_BPS);
    });
  });

  describe("Sell pass — unwinding over-target holdings", function () {
    /// Establishes a funded, fully-deployed 3-asset position: btc 20%,
    /// nvda 40%, spy 40% of the deployable 90%.
    async function establishDeployedPosition(f) {
      await depositToPool(f.manager, f.vaultSigner, 0, usdcAmount(100_000));
      await submit(
        f.manager, f.riskServiceSigner, f.domain, f.types,
        [f.btc, f.nvda, f.spy], [2000n, 4000n, 4000n], 0n
      );
    }

    it("fully liquidates an asset the new target drops entirely", async function () {
      const f = await loadFixture(deployFixture);
      await establishDeployedPosition(f);

      const managerAddress = await f.manager.getAddress();
      expect(await f.btcToken.balanceOf(managerAddress)).to.be.gt(0);

      // btc omitted from the target -> _targetWeightOf returns 0 -> its whole
      // balance is excess. Crypto weight 2000 -> 0 is a de-risk, so this
      // executes immediately rather than waiting out the §9.6 delay.
      await submit(f.manager, f.riskServiceSigner, f.domain, f.types, [f.nvda, f.spy], [5000n, 5000n], 1n);

      expect(await f.btcToken.balanceOf(managerAddress)).to.equal(0);
      expect(await usdcShareBps(f.manager, f.usdc)).to.be.gte(MIN_LIQUIDITY_FLOOR_BPS);
    });

    it("sells an over-target asset down toward its target without liquidating it", async function () {
      const f = await loadFixture(deployFixture);
      await establishDeployedPosition(f);

      const managerAddress = await f.manager.getAddress();
      const nvdaBefore = await f.nvdaToken.balanceOf(managerAddress);

      // nvda 40% -> 25%: over target, sold down but still held.
      await submit(
        f.manager, f.riskServiceSigner, f.domain, f.types,
        [f.btc, f.nvda, f.spy], [2000n, 2500n, 5500n], 1n
      );

      const nvdaAfter = await f.nvdaToken.balanceOf(managerAddress);
      expect(nvdaAfter).to.be.lt(nvdaBefore);
      expect(nvdaAfter).to.be.gt(0);
      expect(await usdcShareBps(f.manager, f.usdc)).to.be.gte(MIN_LIQUIDITY_FLOOR_BPS);
    });

    it("executes no swaps when holdings already match the target (a no-op rebalance does not churn)", async function () {
      const f = await loadFixture(deployFixture);

      // Deliberately a 2-asset btc/nvda position, NOT the 3-asset one used
      // above: btc (8dp) and nvda (18dp) targets are exactly representable at
      // these prices, so the portfolio lands precisely on target and a
      // re-submission is a genuine no-op.
      //
      // spy (6dp @ $550) is excluded on purpose. Its target is NOT exactly
      // representable, so acquiring it leaves the portfolio a few USDC-units
      // off target, and a re-submission legitimately trades that dust away.
      // That is correct behavior, not churn — but it would make "no swaps
      // occurred" the wrong assertion, and asserting it anyway would be
      // testing a premise the arithmetic does not support. Dust-scale
      // re-trading is what §9.5's deferred deadband exists to suppress.
      await depositToPool(f.manager, f.vaultSigner, 0, usdcAmount(100_000));
      await submit(f.manager, f.riskServiceSigner, f.domain, f.types, [f.btc, f.nvda], [4000n, 6000n], 0n);

      const swapsAfterSetup = await f.swapRouter.swapCount();
      const valueBefore = await f.manager.getRiskLegValue(0);

      // Same weights resubmitted. Equal crypto weight classifies as de-risk, so
      // it executes — and must find every asset already at target.
      await submit(f.manager, f.riskServiceSigner, f.domain, f.types, [f.btc, f.nvda], [4000n, 6000n], 1n);

      expect(await f.swapRouter.swapCount()).to.equal(swapsAfterSetup);
      // §10.7: "no-op should never move share price."
      expect(await f.manager.getRiskLegValue(0)).to.equal(valueBefore);
    });
  });

  describe("Slippage protection (§9.9 — oracle-derived floor)", function () {
    it("executes when the pool fills within the tolerance", async function () {
      const { manager, riskServiceSigner, vaultSigner, swapRouter, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await swapRouter.setOutputHaircutBps(100); // 1% adverse, inside the 2% tolerance
      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));

      await expect(
        submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n)
      ).to.not.be.reverted;
    });

    it("reverts the ENTIRE rebalance when the pool cannot meet the oracle-derived minimum", async function () {
      const { manager, riskServiceSigner, vaultSigner, swapRouter, usdc, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await swapRouter.setOutputHaircutBps(300); // 3% adverse, outside the 2% tolerance
      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));

      await expect(
        submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n)
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientOutputAmount");

      // All-or-nothing: no partial deployment, and the nonce did not advance,
      // so the same allocation can be resubmitted once liquidity improves.
      expect(await usdc.balanceOf(await manager.getAddress())).to.equal(usdcAmount(100_000));
      expect(await manager.allocationNonce()).to.equal(0n);
    });

    it("a widened tolerance admits a fill that a tighter one rejected", async function () {
      const { manager, owner, riskServiceSigner, vaultSigner, swapRouter, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await swapRouter.setOutputHaircutBps(300);
      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));

      await expect(
        submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n)
      ).to.be.revertedWithCustomError(swapRouter, "InsufficientOutputAmount");

      await manager.connect(owner).setMaxSlippageBps(400);

      await expect(
        submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n)
      ).to.not.be.reverted;
    });
  });

  describe("§10.9 oracle staleness, wired into the rebalance path", function () {
    it("reverts the rebalance when a target asset's feed has gone stale", async function () {
      const { manager, oracle, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));

      // §10.9: "Chainlink feed returns a stale timestamp -> rebalance must
      // revert, not execute on stale data." This is the assertion that closes
      // the §16 item 3 / §17 item 3 gap at the RiskLegManager level — before
      // this, OracleConsumer could revert on stale data but nothing in the
      // rebalance path consulted it.
      await time.increase(MAX_STALENESS + 1);

      await expect(
        submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n)
      ).to.be.revertedWithCustomError(oracle, "StalePrice");
    });

    it("reverts the rebalance when a target asset's feed has been removed entirely", async function () {
      const { manager, oracle, owner, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await oracle.connect(owner).removeFeed(btc);

      // §9.8: on risk-service/oracle unavailability the contract holds its last
      // valid allocation and accepts no new instructions — it does not fall back
      // to full-liquidate or full-deploy.
      await expect(
        submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n)
      ).to.be.revertedWithCustomError(oracle, "AssetNotConfigured");
    });

    it("blocks valuation of an already-held position once its feed goes stale (disclosed redemption coupling)", async function () {
      const { manager, riskServiceSigner, vaultSigner, oracle, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      expect(await manager.getRiskLegValue(0)).to.equal(usdcAmount(100_000));

      await time.increase(MAX_STALENESS + 1);

      // Documented consequence, not an accident — see _totalPoolValue's
      // DISCLOSED CONSEQUENCE note. A share's pro-rata value is undefined while
      // a held asset is unpriceable, so redemption defers rather than paying out
      // against a stale mark.
      await expect(manager.getRiskLegValue(0)).to.be.revertedWithCustomError(oracle, "StalePrice");
      await expect(manager.connect(vaultSigner).withdrawRiskLeg(0)).to.be.revertedWithCustomError(
        oracle,
        "StalePrice"
      );
    });
  });

  describe("§9.8 liquidity floor as an enforced post-execution invariant", function () {
    it("reverts the whole rebalance if post-execution USDC would fall below the 10% floor", async function () {
      const { manager, riskServiceSigner, vaultSigner, swapRouter, usdc, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      const usdcAddress = await usdc.getAddress();

      // NOTE ON HOW THIS SCENARIO IS CONSTRUCTED, stated precisely because the
      // obvious construction does not work: ordinary ADVERSE slippage provably
      // cannot breach the floor. Selling at a haircut converts assets into MORE
      // USDC relative to remaining value, and buying at a haircut shrinks total
      // value while leaving the retained USDC untouched — both push the USDC
      // share UP. Writing a test that claimed otherwise would be asserting
      // something false.
      //
      // The floor is reachable from the opposite direction: a pool that fills
      // BETTER than the oracle prices (equivalently, an oracle under-pricing the
      // asset) inflates post-buy holdings, so the reserved 10% becomes a smaller
      // fraction of a larger total. That is a real oracle/pool divergence, and
      // it is what this test simulates.
      const btcPriceRaw = ethers.parseUnits("60000", FEED_DECIMALS);
      const nvdaPriceRaw = ethers.parseUnits("180", FEED_DECIMALS);
      await swapRouter.setRate(usdcAddress, btc, 2n * 10n ** 10n, btcPriceRaw);
      await swapRouter.setRate(usdcAddress, nvda, 2n * 10n ** 20n, nvdaPriceRaw);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));

      // Holdings arrive worth ~180,000 against 10,000 retained USDC, i.e. a
      // ~5.26% USDC share — below the 1000 bps floor, so the hard bound fires.
      await expect(
        submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n)
      ).to.be.revertedWithCustomError(manager, "LiquidityFloorViolated");

      // Hard bounds are not advisory: nothing was deployed and the nonce held.
      expect(await usdc.balanceOf(await manager.getAddress())).to.equal(usdcAmount(100_000));
      expect(await manager.allocationNonce()).to.equal(0n);
    });

    it("skips the floor assertion on an empty pool rather than dividing by zero", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);

      // Total value is zero, so the floor — a FRACTION of total value — is
      // undefined. Recording a target before capital arrives is legitimate and
      // must not revert.
      await expect(
        submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n)
      ).to.emit(manager, "RebalanceExecuted");

      const [, weights] = await manager.getCurrentAllocation();
      expect(weights).to.deep.equal([4000n, 6000n]);
    });
  });

  describe("Pool valuation across held assets (§9.10 live valuation, §10.7 share accounting)", function () {
    it("values the pool as idle USDC plus the live oracle-priced value of every holding", async function () {
      const { manager, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      // 10,000 USDC + 0.6 BTC ($36,000) + 300 NVDA ($54,000) == 100,000. A
      // rebalance at fair prices is value-neutral.
      expect(await manager.totalPoolValue()).to.equal(usdcAmount(100_000));
      // §10.7: "Share price correctness immediately after a rebalance (must
      // reflect actual post-trade holdings, not stale pre-trade state)."
      expect(await manager.getRiskLegValue(0)).to.equal(usdcAmount(100_000));
    });

    it("reprices holdings live when a feed moves, with no redeploy or cached value", async function () {
      const { manager, riskServiceSigner, vaultSigner, btcFeed, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      // BTC $60,000 -> $90,000. The pool holds 0.6 BTC, so its value rises from
      // $36,000 to $54,000: total 100,000 -> 118,000.
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await btcFeed.setLatestAnswer(ethers.parseUnits("90000", FEED_DECIMALS), now);

      expect(await manager.totalPoolValue()).to.equal(usdcAmount(118_000));
      expect(await manager.getRiskLegValue(0)).to.equal(usdcAmount(118_000));
    });

    it("splits pool value pro-rata across notes when the pool holds assets rather than USDC", async function () {
      const { manager, riskServiceSigner, vaultSigner, btc, nvda, domain, types } =
        await loadFixture(deployFixture);

      await depositToPool(manager, vaultSigner, 0, usdcAmount(100_000));
      await submit(manager, riskServiceSigner, domain, types, [btc, nvda], [4000n, 6000n], 0n);

      // Second note deposits into a pool that is now mostly non-USDC. Share
      // minting has to price the existing holdings correctly to avoid diluting
      // either noteholder.
      await depositToPool(manager, vaultSigner, 1, usdcAmount(100_000));

      expect(await manager.getRiskLegValue(0)).to.equal(usdcAmount(100_000));
      expect(await manager.getRiskLegValue(1)).to.equal(usdcAmount(100_000));
      expect(await manager.totalPoolValue()).to.equal(usdcAmount(200_000));
    });
  });
});
