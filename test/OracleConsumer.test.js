const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("OracleConsumer", function () {
  const FEED_DECIMALS = 8; // standard Chainlink USD-pair decimals
  const DEFAULT_MAX_STALENESS = 3600; // 1 hour, arbitrary test value — NOT a
                                       // production recommendation, see §9.9
                                       // discussion on needing real feed data

  async function deployFixture() {
    const [owner, otherAccount] = await ethers.getSigners();
    const assetAddress = ethers.getAddress("0x1111111111111111111111111111111111111".padEnd(42, "1"));

    const OracleConsumer = await ethers.getContractFactory("OracleConsumer");
    const oracle = await OracleConsumer.deploy();

    const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
    const aggregator = await MockChainlinkAggregator.deploy(FEED_DECIMALS);

    return { oracle, aggregator, owner, otherAccount, assetAddress };
  }

  async function currentTimestamp() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  // -------------------------------------------------------------------------
  // configureFeed
  // -------------------------------------------------------------------------

  describe("configureFeed", function () {
    it("only owner can configure a feed", async function () {
      const { oracle, aggregator, otherAccount, assetAddress } = await loadFixture(deployFixture);
      await expect(
        oracle
          .connect(otherAccount)
          .configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS)
      ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero aggregator address", async function () {
      const { oracle, owner, assetAddress } = await loadFixture(deployFixture);
      await expect(
        oracle.connect(owner).configureFeed(assetAddress, ethers.ZeroAddress, DEFAULT_MAX_STALENESS)
      ).to.be.revertedWithCustomError(oracle, "ZeroAggregatorAddress");
    });

    it("reverts on zero maxStalenessSeconds", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await expect(
        oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), 0)
      ).to.be.revertedWithCustomError(oracle, "InvalidMaxStaleness");
    });

    it("emits FeedConfigured on success", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      const aggregatorAddress = await aggregator.getAddress();

      await expect(
        oracle.connect(owner).configureFeed(assetAddress, aggregatorAddress, DEFAULT_MAX_STALENESS)
      )
        .to.emit(oracle, "FeedConfigured")
        .withArgs(assetAddress, aggregatorAddress, DEFAULT_MAX_STALENESS);
    });

    it("allows reconfiguring an already-configured asset (update, not just initial set)", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      const aggregatorAddress = await aggregator.getAddress();

      await oracle.connect(owner).configureFeed(assetAddress, aggregatorAddress, 3600);
      await oracle.connect(owner).configureFeed(assetAddress, aggregatorAddress, 7200);

      // No direct getter for maxStalenessSeconds alone, but isFresh/getPrice
      // behavior against the updated threshold is exercised in later tests.
      const feed = await oracle.feeds(assetAddress);
      expect(feed.maxStalenessSeconds).to.equal(7200);
    });
  });

  // -------------------------------------------------------------------------
  // removeFeed
  // -------------------------------------------------------------------------

  describe("removeFeed", function () {
    it("only owner can remove a feed", async function () {
      const { oracle, otherAccount, assetAddress } = await loadFixture(deployFixture);
      await expect(oracle.connect(otherAccount).removeFeed(assetAddress)).to.be.revertedWithCustomError(
        oracle,
        "OwnableUnauthorizedAccount"
      );
    });

    it("emits FeedRemoved and getPrice reverts with AssetNotConfigured afterward", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      await expect(oracle.connect(owner).removeFeed(assetAddress))
        .to.emit(oracle, "FeedRemoved")
        .withArgs(assetAddress);

      await expect(oracle.getPrice(assetAddress)).to.be.revertedWithCustomError(
        oracle,
        "AssetNotConfigured"
      );
    });
  });

  // -------------------------------------------------------------------------
  // getPrice — core §10.9 staleness enforcement
  // -------------------------------------------------------------------------

  describe("getPrice", function () {
    it("reverts for an unconfigured asset", async function () {
      const { oracle, assetAddress } = await loadFixture(deployFixture);
      await expect(oracle.getPrice(assetAddress)).to.be.revertedWithCustomError(
        oracle,
        "AssetNotConfigured"
      );
    });

    it("returns the latest price when fresh", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      const price = 350_00000000n; // e.g. $350.00000000 at 8 decimals
      await aggregator.setLatestAnswer(price, now);

      expect(await oracle.getPrice(assetAddress)).to.equal(price);
    });

    it("reverts with StalePrice when updatedAt exceeds maxStalenessSeconds", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      await aggregator.setLatestAnswer(100_00000000n, now);

      // Advance time well past the staleness threshold.
      await time.increase(DEFAULT_MAX_STALENESS + 1);

      await expect(oracle.getPrice(assetAddress)).to.be.revertedWithCustomError(oracle, "StalePrice");
    });

    it("does NOT revert at exactly the staleness boundary", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      // Pin the NEXT block's timestamp explicitly before mining, so the
      // transaction that sets updatedAt lands at EXACTLY the value we pass
      // as the argument — no off-by-one from auto-mining.
      const target = (await time.latest()) + 100;
      await time.setNextBlockTimestamp(target);
      await aggregator.setLatestAnswer(100_00000000n, target);

      // time.increase(N) advances from the current latest block (target) by
      // exactly N, and mines a new block at target + N.
      await time.increase(DEFAULT_MAX_STALENESS);

      // block.timestamp - updatedAt == (target + N) - target == N exactly,
      // which must NOT exceed maxStalenessSeconds (strict > check in the
      // contract) — so this must not revert.
      await expect(oracle.getPrice(assetAddress)).to.not.be.reverted;
    });

    it("reverts one second past the staleness boundary", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      await aggregator.setLatestAnswer(100_00000000n, now);

      await time.increase(DEFAULT_MAX_STALENESS + 1);

      await expect(oracle.getPrice(assetAddress)).to.be.revertedWithCustomError(oracle, "StalePrice");
    });

    it("reverts with NonPositivePrice when the feed returns zero", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      await aggregator.setLatestAnswer(0, now);

      await expect(oracle.getPrice(assetAddress)).to.be.revertedWithCustomError(
        oracle,
        "NonPositivePrice"
      );
    });

    it("reverts with NonPositivePrice when the feed returns a negative answer", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      await aggregator.setLatestAnswer(-1, now);

      await expect(oracle.getPrice(assetAddress)).to.be.revertedWithCustomError(
        oracle,
        "NonPositivePrice"
      );
    });

    it("never fails open: a stale price reverts the CALLING transaction rather than returning a default", async function () {
      // §9.8/§10.9 design principle check: this test exists specifically to
      // assert the ABSENCE of any fallback value. getPrice() either returns
      // a genuinely fresh price or reverts — there is no third path where it
      // silently returns 0, a cached stale value, or any other default.
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      await aggregator.setLatestAnswer(999_00000000n, now);
      await time.increase(DEFAULT_MAX_STALENESS + 100);

      // The ONLY acceptable outcome here is a revert — not a return value of
      // any kind, stale or otherwise.
      let reverted = false;
      try {
        await oracle.getPrice(assetAddress);
      } catch (err) {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // decimals
  // -------------------------------------------------------------------------

  describe("decimals", function () {
    it("returns the aggregator's configured decimals", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      expect(await oracle.decimals(assetAddress)).to.equal(FEED_DECIMALS);
    });

    it("reverts for an unconfigured asset", async function () {
      const { oracle, assetAddress } = await loadFixture(deployFixture);
      await expect(oracle.decimals(assetAddress)).to.be.revertedWithCustomError(
        oracle,
        "AssetNotConfigured"
      );
    });
  });

  // -------------------------------------------------------------------------
  // isFresh — non-reverting staleness check
  // -------------------------------------------------------------------------

  describe("isFresh", function () {
    it("returns false for an unconfigured asset (no revert)", async function () {
      const { oracle, assetAddress } = await loadFixture(deployFixture);
      expect(await oracle.isFresh(assetAddress)).to.equal(false);
    });

    it("returns true for a fresh, positive-priced feed", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      await aggregator.setLatestAnswer(100_00000000n, now);

      expect(await oracle.isFresh(assetAddress)).to.equal(true);
    });

    it("returns false for a stale feed (no revert)", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      await aggregator.setLatestAnswer(100_00000000n, now);
      await time.increase(DEFAULT_MAX_STALENESS + 1);

      expect(await oracle.isFresh(assetAddress)).to.equal(false);
    });

    it("returns false for a non-positive price even if timestamp is fresh", async function () {
      const { oracle, aggregator, owner, assetAddress } = await loadFixture(deployFixture);
      await oracle.connect(owner).configureFeed(assetAddress, await aggregator.getAddress(), DEFAULT_MAX_STALENESS);

      const now = await currentTimestamp();
      await aggregator.setLatestAnswer(0, now);

      expect(await oracle.isFresh(assetAddress)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // Per-asset independence — configuring one feed must not affect another
  // -------------------------------------------------------------------------

  describe("Per-asset feed independence", function () {
    it("different assets can have different staleness thresholds simultaneously", async function () {
      const { oracle, owner } = await loadFixture(deployFixture);
      const assetA = ethers.getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      const assetB = ethers.getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

      const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
      const aggA = await MockChainlinkAggregator.deploy(8);
      const aggB = await MockChainlinkAggregator.deploy(8);

      // Asset A: tight 5-minute staleness (e.g. an always-on crypto feed).
      await oracle.connect(owner).configureFeed(assetA, await aggA.getAddress(), 300);
      // Asset B: loose 24-hour staleness (e.g. an equity feed during
      // market-closed hours, per OracleConsumer's own doc comment rationale).
      await oracle.connect(owner).configureFeed(assetB, await aggB.getAddress(), 86_400);

      const now = await currentTimestamp();
      await aggA.setLatestAnswer(100_00000000n, now);
      await aggB.setLatestAnswer(200_00000000n, now);

      // Advance 1 hour: asset A (5-min threshold) should now be stale,
      // asset B (24-hour threshold) should still be fresh.
      await time.increase(3600);

      expect(await oracle.isFresh(assetA)).to.equal(false);
      expect(await oracle.isFresh(assetB)).to.equal(true);
    });
  });
});