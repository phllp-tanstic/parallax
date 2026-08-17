const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeLegManager", function () {
  const USDC_DECIMALS = 6;
  const usdcAmount = (n) => ethers.parseUnits(n.toString(), USDC_DECIMALS);
  const RAY = 10n ** 27n;

  async function deployFixture() {
    const [owner, vaultSigner, otherVault] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);

    const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
    const aavePool = await MockAaveV3Pool.deploy();

    const SafeLegManager = await ethers.getContractFactory("SafeLegManager");
    const manager = await SafeLegManager.deploy(await usdc.getAddress(), await aavePool.getAddress());

    // Wire vaultSigner as the trusted "vault" caller (SafeLegManager's
    // onlyVault modifier). We don't deploy a real ParallaxVault here — this
    // test isolates SafeLegManager's own accounting, calling depositSafeLeg/
    // withdrawSafeLeg directly as the vault would.
    await manager.connect(owner).setVault(vaultSigner.address);

    // Fund vaultSigner with USDC (simulating principal forwarded from a real
    // vault) and approve the manager to pull it.
    await usdc.mint(vaultSigner.address, usdcAmount(1_000_000));
    await usdc.connect(vaultSigner).approve(await manager.getAddress(), ethers.MaxUint256);

    return { manager, usdc, aavePool, owner, vaultSigner, otherVault };
  }

  // -------------------------------------------------------------------------
  // setVault — one-time wiring
  // -------------------------------------------------------------------------

  describe("setVault", function () {
    it("only owner can set the vault", async function () {
      const { manager, vaultSigner, otherVault } = await loadFixture(deployFixture);
      // manager already has vault set from fixture; deploy a fresh one to
      // test the unset state.
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy();
      const SafeLegManager = await ethers.getContractFactory("SafeLegManager");
      const fresh = await SafeLegManager.deploy(await usdc.getAddress(), await aavePool.getAddress());

      await expect(fresh.connect(otherVault).setVault(vaultSigner.address)).to.be.revertedWithCustomError(
        fresh,
        "OwnableUnauthorizedAccount"
      );
    });

    it("cannot be set a second time (immutable trusted caller, no rug-pull redirect)", async function () {
      const { manager, owner, otherVault } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setVault(otherVault.address)).to.be.revertedWithCustomError(
        manager,
        "VaultAlreadySet"
      );
    });
  });

  // -------------------------------------------------------------------------
  // depositSafeLeg
  // -------------------------------------------------------------------------

  describe("depositSafeLeg", function () {
    it("reverts when called by a non-vault address", async function () {
      const { manager, otherVault } = await loadFixture(deployFixture);
      await expect(
        manager.connect(otherVault).depositSafeLeg(0, usdcAmount(1_000))
      ).to.be.revertedWithCustomError(manager, "CallerNotVault");
    });

    it("transfers USDC from caller and supplies to Aave", async function () {
      const { manager, usdc, aavePool, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(9_259.26);

      const vaultBalanceBefore = await usdc.balanceOf(vaultSigner.address);
      await manager.connect(vaultSigner).depositSafeLeg(0, amount);
      const vaultBalanceAfter = await usdc.balanceOf(vaultSigner.address);

      expect(vaultBalanceBefore - vaultBalanceAfter).to.equal(amount);
      expect(await usdc.balanceOf(await aavePool.getAddress())).to.equal(amount);
    });

    it("reverts on a duplicate deposit for the same noteId", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      await manager.connect(vaultSigner).depositSafeLeg(0, usdcAmount(1_000));
      await expect(
        manager.connect(vaultSigner).depositSafeLeg(0, usdcAmount(500))
      ).to.be.revertedWithCustomError(manager, "NoteAlreadyDeposited");
    });

    it("computes scaledAmount correctly at the initial 1.0 liquidity index", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(10_000);

      // At the default index (RAY, i.e. 1.0), scaledAmount == amount exactly:
      // scaledAmount = amount * RAY / RAY = amount.
      await expect(manager.connect(vaultSigner).depositSafeLeg(0, amount))
        .to.emit(manager, "SafeLegDeposited")
        .withArgs(0, amount, amount);
    });
  });

  // -------------------------------------------------------------------------
  // getSafeLegValue / withdrawSafeLeg — §9.10 core accrual correctness
  // -------------------------------------------------------------------------

  describe("Accrual accounting (§9.10 core guarantee)", function () {
    it("returns exactly the deposited amount when liquidity index has not moved", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(9_259.26);
      await manager.connect(vaultSigner).depositSafeLeg(0, amount);

      expect(await manager.getSafeLegValue(0)).to.equal(amount);
    });

    it("reflects accrued yield when liquidity index increases (simulating real Aave accrual)", async function () {
      const { manager, usdc, aavePool, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositSafeLeg(0, amount);

      // Simulate ~8% annual accrual by bumping the liquidity index by 8%.
      const usdcAddress = await usdc.getAddress();
      const newIndex = (RAY * 108n) / 100n;
      await aavePool.setLiquidityIndex(usdcAddress, newIndex);

      const value = await manager.getSafeLegValue(0);
      const expected = (amount * 108n) / 100n;

      // Allow tiny rounding tolerance from RAY-precision integer division.
      const diff = value > expected ? value - expected : expected - value;
      expect(diff).to.be.lte(2n);
    });

    it("gives each note its correct pro-rata share when notes are deposited at different liquidity indices", async function () {
      const { manager, usdc, aavePool, vaultSigner } = await loadFixture(deployFixture);
      const usdcAddress = await usdc.getAddress();

      // Note 0 deposited at index 1.0
      const amount0 = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositSafeLeg(0, amount0);

      // Index accrues 5% before note 1 is deposited.
      await aavePool.setLiquidityIndex(usdcAddress, (RAY * 105n) / 100n);

      const amount1 = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositSafeLeg(1, amount1);

      // Index accrues another 5% (to 1.1025 total from genesis) after both deposits.
      await aavePool.setLiquidityIndex(usdcAddress, (RAY * 105n * 105n) / (100n * 100n));

      const value0 = await manager.getSafeLegValue(0);
      const value1 = await manager.getSafeLegValue(1);

      // Note 0 experienced the full accrual (1.0 -> 1.1025): should be worth
      // ~10.25% more than deposited.
      const expected0 = (amount0 * 11025n) / 10000n;
      // Note 1 only experienced the second 5% leg (1.05 -> 1.1025): should be
      // worth ~5% more than deposited.
      const expected1 = (amount1 * 105n) / 100n;

      expect(value0).to.be.closeTo(expected0, 10n);
      expect(value1).to.be.closeTo(expected1, 10n);

      // Core invariant: note 0's yield rate must be strictly greater than
      // note 1's, since it was exposed to accrual for longer — this is the
      // whole point of per-note scaled-balance accounting instead of an even
      // split (§9.10).
      const gain0 = value0 - amount0;
      const gain1 = value1 - amount1;
      expect(gain0).to.be.gt(gain1);
    });

    it("withdrawSafeLeg pays out the current accrued value and marks withdrawn", async function () {
      const { manager, usdc, aavePool, vaultSigner } = await loadFixture(deployFixture);
      const usdcAddress = await usdc.getAddress();
      const amount = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositSafeLeg(0, amount);

      await aavePool.setLiquidityIndex(usdcAddress, (RAY * 110n) / 100n);
      const expectedValue = (amount * 110n) / 100n;

      // The mock pool only holds what was literally deposited (10,000 USDC).
      // Real Aave generates yield internally via its interest-rate model;
      // this mock has no such mechanism, so the extra accrued amount must be
      // minted directly into the mock pool to simulate "yield having
      // accrued" — otherwise withdraw() has nothing to pay out beyond
      // principal, which is exactly the InsufficientBalance revert seen here.
      const accruedYield = expectedValue - amount;
      await usdc.mint(await aavePool.getAddress(), accruedYield);

      const balanceBefore = await usdc.balanceOf(vaultSigner.address);
      const tx = await manager.connect(vaultSigner).withdrawSafeLeg(0);
      await tx.wait();
      const balanceAfter = await usdc.balanceOf(vaultSigner.address);

      expect(balanceAfter - balanceBefore).to.be.closeTo(expectedValue, 10n);
    });

    it("getSafeLegValue returns 0 after withdrawal", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      await manager.connect(vaultSigner).depositSafeLeg(0, usdcAmount(1_000));
      await manager.connect(vaultSigner).withdrawSafeLeg(0);

      expect(await manager.getSafeLegValue(0)).to.equal(0);
    });

    it("reverts withdrawing a note that was never deposited", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      await expect(manager.connect(vaultSigner).withdrawSafeLeg(999)).to.be.revertedWithCustomError(
        manager,
        "NoteNotDeposited"
      );
    });

    it("reverts withdrawing the same note twice", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      await manager.connect(vaultSigner).depositSafeLeg(0, usdcAmount(1_000));
      await manager.connect(vaultSigner).withdrawSafeLeg(0);

      await expect(manager.connect(vaultSigner).withdrawSafeLeg(0)).to.be.revertedWithCustomError(
        manager,
        "NoteAlreadyWithdrawn"
      );
    });

    it("reverts getSafeLegValue for a note that was never deposited", async function () {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.getSafeLegValue(999)).to.be.revertedWithCustomError(
        manager,
        "NoteNotDeposited"
      );
    });

    it("only vault can call withdrawSafeLeg", async function () {
      const { manager, vaultSigner, otherVault } = await loadFixture(deployFixture);
      await manager.connect(vaultSigner).depositSafeLeg(0, usdcAmount(1_000));

      await expect(manager.connect(otherVault).withdrawSafeLeg(0)).to.be.revertedWithCustomError(
        manager,
        "CallerNotVault"
      );
    });
  });
});