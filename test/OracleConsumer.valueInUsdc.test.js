const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Dedicated coverage for OracleConsumer.valueInUsdc — the token-amount ->
// USDC-value conversion RiskLegManager's rebalancer depends on for both pool
// valuation (§9.10-style live valuation) and its oracle-derived slippage floor
// (§9.9). Kept in its own file rather than appended to OracleConsumer.test.js
// because every case here needs a feed with a DIFFERENT decimals value, which
// the shared 8-decimal fixture in that file deliberately fixes.
describe("OracleConsumer.valueInUsdc", function () {
  const DEFAULT_MAX_STALENESS = 3600; // 1 hour, arbitrary test value — NOT a
                                       // production recommendation, see §9.9
  const USDC_DECIMALS = 6n;

  async function deployFixture() {
    const [owner, otherAccount] = await ethers.getSigners();

    const OracleConsumer = await ethers.getContractFactory("OracleConsumer");
    const oracle = await OracleConsumer.deploy();

    return { oracle, owner, otherAccount };
  }

  function makeAddress(seed) {
    return ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(seed), 20));
  }

  async function currentTimestamp() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  /// Wires a fresh feed with `feedDecimals` reporting `humanPrice` USD for
  /// `asset`, and returns the asset address ready for a valueInUsdc call.
  async function configureFreshFeed(oracle, owner, seed, feedDecimals, humanPrice) {
    const asset = makeAddress(seed);

    const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
    const aggregator = await MockChainlinkAggregator.deploy(feedDecimals);

    await oracle
      .connect(owner)
      .configureFeed(asset, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

    const answer = ethers.parseUnits(humanPrice.toString(), feedDecimals);
    await aggregator.setLatestAnswer(answer, await currentTimestamp());

    return { asset, aggregator, answer };
  }

  // -------------------------------------------------------------------------
  // The worked example, stated exactly as the spec states it
  // -------------------------------------------------------------------------

  describe("worked example", function () {
    it("1 BTC at $60,000 with an 8-decimal feed and an 8-decimal token == 60,000 * 1e6 USDC", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 1, 8, 60_000);

      const oneBtc = ethers.parseUnits("1", 8);
      const value = await oracle.valueInUsdc(asset, oneBtc, 8);

      expect(value).to.equal(60_000n * 10n ** USDC_DECIMALS);
      // Restated independently of the helper, so a bug in parseUnits usage
      // above cannot make this assertion vacuously true.
      expect(value).to.equal(60_000_000_000n);
    });
  });

  // -------------------------------------------------------------------------
  // Decimal combinations — the whole point of the function
  // -------------------------------------------------------------------------

  describe("decimal combinations", function () {
    it("6-decimal token / 8-decimal feed", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 2, 8, 2);

      // 1 token at $2 -> $2.00 expressed in USDC's 6 decimals.
      const value = await oracle.valueInUsdc(asset, ethers.parseUnits("1", 6), 6);
      expect(value).to.equal(ethers.parseUnits("2", 6));
    });

    it("18-decimal token / 8-decimal feed", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 3, 8, 3_000);

      // 1 token at $3,000 -> 3_000 * 1e6.
      const value = await oracle.valueInUsdc(asset, ethers.parseUnits("1", 18), 18);
      expect(value).to.equal(ethers.parseUnits("3000", 6));
    });

    it("6-decimal token / 18-decimal feed", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 4, 18, 2);

      const value = await oracle.valueInUsdc(asset, ethers.parseUnits("1", 6), 6);
      expect(value).to.equal(ethers.parseUnits("2", 6));
    });

    it("exercises the exponent < 6 branch (2-decimal token / 2-decimal feed) — multiplies rather than divides", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      // assetTokenDecimals + feedDecimals == 4, which is < 6, so the function
      // takes its scale-UP path. Without a case here that branch is dead code
      // as far as the test suite is concerned.
      const { asset } = await configureFreshFeed(oracle, owner, 5, 2, 5);

      const value = await oracle.valueInUsdc(asset, ethers.parseUnits("1", 2), 2);
      expect(value).to.equal(ethers.parseUnits("5", 6));
    });

    it("handles a large 18-decimal position without overflow", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 6, 8, 3_000);

      // 1,000,000 tokens at $3,000 == $3,000,000,000.
      const value = await oracle.valueInUsdc(asset, ethers.parseUnits("1000000", 18), 18);
      expect(value).to.equal(ethers.parseUnits("3000000000", 6));
    });
  });

  // -------------------------------------------------------------------------
  // Scaling and rounding behavior
  // -------------------------------------------------------------------------

  describe("scaling and rounding", function () {
    it("scales linearly with amount", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 7, 8, 60_000);

      const one = await oracle.valueInUsdc(asset, ethers.parseUnits("1", 8), 8);
      const two = await oracle.valueInUsdc(asset, ethers.parseUnits("2", 8), 8);
      const half = await oracle.valueInUsdc(asset, ethers.parseUnits("0.5", 8), 8);

      expect(two).to.equal(one * 2n);
      expect(half).to.equal(one / 2n);
    });

    it("returns zero for a zero amount", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 8, 8, 60_000);

      expect(await oracle.valueInUsdc(asset, 0, 8)).to.equal(0);
    });

    it("rounds DOWN (truncates) — a sub-USDC-unit dust amount values at zero, never rounds up", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 9, 8, 1);

      // 1 wei of an 18-decimal token at $1 is worth 1e-18 USD, far below one
      // USDC unit (1e-6). Truncation is the SAFE direction for the slippage
      // floor in RiskLegManager._swap — see the ROUNDING note on the function.
      expect(await oracle.valueInUsdc(asset, 1n, 18)).to.equal(0);
    });
  });

  // -------------------------------------------------------------------------
  // §10.9 — inherits getPrice()'s failure modes, never returns stale-derived value
  // -------------------------------------------------------------------------

  describe("staleness and failure propagation (§10.9)", function () {
    it("reverts with StalePrice once the feed passes its staleness threshold", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 10, 8, 60_000);

      // Fresh first — proves the revert below is caused by staleness alone,
      // not by a misconfigured feed.
      await expect(oracle.valueInUsdc(asset, ethers.parseUnits("1", 8), 8)).to.not.be.reverted;

      await time.increase(DEFAULT_MAX_STALENESS + 1);

      await expect(
        oracle.valueInUsdc(asset, ethers.parseUnits("1", 8), 8)
      ).to.be.revertedWithCustomError(oracle, "StalePrice");
    });

    it("does NOT revert at exactly the staleness boundary", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const asset = makeAddress(11);

      const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
      const aggregator = await MockChainlinkAggregator.deploy(8);
      await oracle
        .connect(owner)
        .configureFeed(asset, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      // Pin the next block's timestamp so updatedAt lands exactly on the value
      // passed in — same technique as OracleConsumer.test.js's boundary case.
      const target = (await time.latest()) + 100;
      await time.setNextBlockTimestamp(target);
      await aggregator.setLatestAnswer(ethers.parseUnits("60000", 8), target);

      await time.increase(DEFAULT_MAX_STALENESS);

      await expect(oracle.valueInUsdc(asset, ethers.parseUnits("1", 8), 8)).to.not.be.reverted;
    });

    it("reverts with AssetNotConfigured for an asset that has no feed", async function () {
      const { oracle } = await loadFixture(deployFixture);
      await expect(
        oracle.valueInUsdc(makeAddress(12), ethers.parseUnits("1", 8), 8)
      ).to.be.revertedWithCustomError(oracle, "AssetNotConfigured");
    });

    it("reverts with NonPositivePrice when the feed reports zero", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const asset = makeAddress(13);

      const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
      const aggregator = await MockChainlinkAggregator.deploy(8);
      await oracle
        .connect(owner)
        .configureFeed(asset, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);
      await aggregator.setLatestAnswer(0, await currentTimestamp());

      await expect(
        oracle.valueInUsdc(asset, ethers.parseUnits("1", 8), 8)
      ).to.be.revertedWithCustomError(oracle, "NonPositivePrice");
    });

    it("reverts with NonPositivePrice when the feed reports a negative answer", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const asset = makeAddress(14);

      const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
      const aggregator = await MockChainlinkAggregator.deploy(8);
      await oracle
        .connect(owner)
        .configureFeed(asset, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);
      await aggregator.setLatestAnswer(-1, await currentTimestamp());

      await expect(
        oracle.valueInUsdc(asset, ethers.parseUnits("1", 8), 8)
      ).to.be.revertedWithCustomError(oracle, "NonPositivePrice");
    });

    it("reverts after the feed is removed, even though it previously worked", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const { asset } = await configureFreshFeed(oracle, owner, 15, 8, 60_000);

      await expect(oracle.valueInUsdc(asset, ethers.parseUnits("1", 8), 8)).to.not.be.reverted;

      await oracle.connect(owner).removeFeed(asset);

      await expect(
        oracle.valueInUsdc(asset, ethers.parseUnits("1", 8), 8)
      ).to.be.revertedWithCustomError(oracle, "AssetNotConfigured");
    });
  });
});
