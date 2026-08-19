const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("RiskLegManager", function () {
  const USDC_DECIMALS = 6;
  const usdcAmount = (n) => ethers.parseUnits(n.toString(), USDC_DECIMALS);

  // These share-accounting tests deliberately never populate an allocation, so
  // _totalPoolValue() reduces to the idle USDC balance and no oracle or router
  // call is reachable. The router/oracle are wired only because the constructor
  // now requires them; swap-execution behavior is covered in
  // RiskLegManager.rebalance.test.js, where the pool actually holds assets.
  async function deployManager(usdcAddress) {
    const MockUniswapV3Router = await ethers.getContractFactory("MockUniswapV3Router");
    const swapRouter = await MockUniswapV3Router.deploy();

    const OracleConsumer = await ethers.getContractFactory("OracleConsumer");
    const oracle = await OracleConsumer.deploy();

    const RiskLegManager = await ethers.getContractFactory("RiskLegManager");
    const manager = await RiskLegManager.deploy(
      usdcAddress,
      await swapRouter.getAddress(),
      await oracle.getAddress()
    );

    return { manager, swapRouter, oracle };
  }

  async function deployFixture() {
    const [owner, vaultSigner, otherVault] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);

    const { manager, swapRouter, oracle } = await deployManager(await usdc.getAddress());

    await manager.connect(owner).setVault(vaultSigner.address);

    await usdc.mint(vaultSigner.address, usdcAmount(1_000_000));
    await usdc.connect(vaultSigner).approve(await manager.getAddress(), ethers.MaxUint256);

    return { manager, usdc, swapRouter, oracle, owner, vaultSigner, otherVault };
  }

  // -------------------------------------------------------------------------
  // Deployment wiring
  // -------------------------------------------------------------------------

  describe("Deployment", function () {
    it("records the USDC, router, and oracle addresses passed to the constructor", async function () {
      const { manager, usdc, swapRouter, oracle } = await loadFixture(deployFixture);

      expect(await manager.usdc()).to.equal(await usdc.getAddress());
      expect(await manager.swapRouter()).to.equal(await swapRouter.getAddress());
      expect(await manager.oracleConsumer()).to.equal(await oracle.getAddress());
    });
  });

  // -------------------------------------------------------------------------
  // setVault — same one-time-wiring pattern as SafeLegManager
  // -------------------------------------------------------------------------

  describe("setVault", function () {
    it("only owner can set the vault", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
      const { manager: fresh } = await deployManager(await usdc.getAddress());

      const [, vaultSigner, otherVault] = await ethers.getSigners();
      await expect(fresh.connect(otherVault).setVault(vaultSigner.address)).to.be.revertedWithCustomError(
        fresh,
        "OwnableUnauthorizedAccount"
      );
    });

    it("cannot be set a second time", async function () {
      const { manager, owner, otherVault } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setVault(otherVault.address)).to.be.revertedWithCustomError(
        manager,
        "VaultAlreadySet"
      );
    });
  });

  // -------------------------------------------------------------------------
  // depositRiskLeg
  // -------------------------------------------------------------------------

  describe("depositRiskLeg", function () {
    it("reverts when called by a non-vault address", async function () {
      const { manager, otherVault } = await loadFixture(deployFixture);
      await expect(
        manager.connect(otherVault).depositRiskLeg(0, usdcAmount(1_000))
      ).to.be.revertedWithCustomError(manager, "CallerNotVault");
    });

    it("first deposit mints shares 1:1 with amount", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(740.74); // matches §9.1 worked-example risk leg

      await expect(manager.connect(vaultSigner).depositRiskLeg(0, amount))
        .to.emit(manager, "RiskLegDeposited")
        .withArgs(0, amount, amount);

      expect(await manager.totalShares()).to.equal(amount);
    });

    it("transfers USDC from caller into the pool", async function () {
      const { manager, usdc, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(1_000);

      const balanceBefore = await usdc.balanceOf(vaultSigner.address);
      await manager.connect(vaultSigner).depositRiskLeg(0, amount);
      const balanceAfter = await usdc.balanceOf(vaultSigner.address);

      expect(balanceBefore - balanceAfter).to.equal(amount);
      expect(await usdc.balanceOf(await manager.getAddress())).to.equal(amount);
    });

    it("reverts on a duplicate deposit for the same noteId", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      await manager.connect(vaultSigner).depositRiskLeg(0, usdcAmount(1_000));
      await expect(
        manager.connect(vaultSigner).depositRiskLeg(0, usdcAmount(500))
      ).to.be.revertedWithCustomError(manager, "NoteAlreadyDeposited");
    });

    it("mints shares proportionally when the pool has appreciated before a new deposit (fairness to earlier depositors)", async function () {
      const { manager, usdc, vaultSigner } = await loadFixture(deployFixture);

      const amount0 = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositRiskLeg(0, amount0);
      expect(await manager.totalShares()).to.equal(amount0);

      await usdc.mint(await manager.getAddress(), usdcAmount(2_000)); // pool now worth 12,000

      const amount1 = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositRiskLeg(1, amount1);

      const expectedNewShares = (amount1 * amount0) / usdcAmount(12_000);
      const totalSharesAfter = await manager.totalShares();

      expect(totalSharesAfter).to.equal(amount0 + expectedNewShares);

      const value0 = await manager.getRiskLegValue(0);
      const value1 = await manager.getRiskLegValue(1);
      expect(value0).to.be.gt(value1);
    });

    it("mints shares proportionally when the pool has DEPRECIATED before a new deposit (new depositor isn't diluted by prior losses)", async function () {
      const { manager, usdc, vaultSigner } = await loadFixture(deployFixture);

      const amount0 = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositRiskLeg(0, amount0);
      expect(await manager.totalShares()).to.equal(amount0);

      const managerAddress = await manager.getAddress();
      await usdc.burn(managerAddress, usdcAmount(3_000)); // pool now worth 7,000

      const amount1 = usdcAmount(7_000);
      await manager.connect(vaultSigner).depositRiskLeg(1, amount1);

      const expectedNewShares = (amount1 * amount0) / usdcAmount(7_000);
      const totalSharesAfter = await manager.totalShares();

      expect(totalSharesAfter).to.equal(amount0 + expectedNewShares);
      expect(expectedNewShares).to.equal(amount0);

      const value0 = await manager.getRiskLegValue(0);
      const value1 = await manager.getRiskLegValue(1);
      expect(value0).to.equal(value1);
      expect(value0).to.equal(usdcAmount(7_000));
    });
  });

  // -------------------------------------------------------------------------
  // withdrawRiskLeg / getRiskLegValue
  // -------------------------------------------------------------------------

  describe("withdrawRiskLeg / getRiskLegValue", function () {
    it("returns exactly the deposited amount when pool value hasn't changed", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(1_000);
      await manager.connect(vaultSigner).depositRiskLeg(0, amount);

      expect(await manager.getRiskLegValue(0)).to.equal(amount);
    });

    it("reflects pool-wide gains proportionally", async function () {
      const { manager, usdc, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositRiskLeg(0, amount);

      await usdc.mint(await manager.getAddress(), usdcAmount(5_000));

      expect(await manager.getRiskLegValue(0)).to.equal(usdcAmount(15_000));
    });

    it("withdrawRiskLeg pays out current value and reduces totalShares", async function () {
      const { manager, usdc, vaultSigner } = await loadFixture(deployFixture);
      const amount = usdcAmount(10_000);
      await manager.connect(vaultSigner).depositRiskLeg(0, amount);
      await usdc.mint(await manager.getAddress(), usdcAmount(2_000));

      const balanceBefore = await usdc.balanceOf(vaultSigner.address);
      const tx = await manager.connect(vaultSigner).withdrawRiskLeg(0);
      await tx.wait();
      const balanceAfter = await usdc.balanceOf(vaultSigner.address);

      expect(balanceAfter - balanceBefore).to.equal(usdcAmount(12_000));
      expect(await manager.totalShares()).to.equal(0);
    });

    it("multiple notes withdraw their correct pro-rata share independently", async function () {
      const { manager, usdc, vaultSigner } = await loadFixture(deployFixture);

      await manager.connect(vaultSigner).depositRiskLeg(0, usdcAmount(10_000));
      await manager.connect(vaultSigner).depositRiskLeg(1, usdcAmount(10_000));
      await usdc.mint(await manager.getAddress(), usdcAmount(2_000));

      const value0 = await manager.getRiskLegValue(0);
      const value1 = await manager.getRiskLegValue(1);
      expect(value0).to.equal(usdcAmount(11_000));
      expect(value1).to.equal(usdcAmount(11_000));

      await manager.connect(vaultSigner).withdrawRiskLeg(0);

      expect(await manager.getRiskLegValue(1)).to.equal(usdcAmount(11_000));
    });

    it("getRiskLegValue returns 0 after withdrawal", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      await manager.connect(vaultSigner).depositRiskLeg(0, usdcAmount(1_000));
      await manager.connect(vaultSigner).withdrawRiskLeg(0);

      expect(await manager.getRiskLegValue(0)).to.equal(0);
    });

    it("reverts withdrawing a note that was never deposited", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      await expect(manager.connect(vaultSigner).withdrawRiskLeg(999)).to.be.revertedWithCustomError(
        manager,
        "NoteNotDeposited"
      );
    });

    it("reverts withdrawing the same note twice", async function () {
      const { manager, vaultSigner } = await loadFixture(deployFixture);
      await manager.connect(vaultSigner).depositRiskLeg(0, usdcAmount(1_000));
      await manager.connect(vaultSigner).withdrawRiskLeg(0);

      await expect(manager.connect(vaultSigner).withdrawRiskLeg(0)).to.be.revertedWithCustomError(
        manager,
        "NoteAlreadyWithdrawn"
      );
    });

    it("reverts getRiskLegValue for a note that was never deposited", async function () {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.getRiskLegValue(999)).to.be.revertedWithCustomError(
        manager,
        "NoteNotDeposited"
      );
    });

    it("only vault can call withdrawRiskLeg", async function () {
      const { manager, vaultSigner, otherVault } = await loadFixture(deployFixture);
      await manager.connect(vaultSigner).depositRiskLeg(0, usdcAmount(1_000));

      await expect(manager.connect(otherVault).withdrawRiskLeg(0)).to.be.revertedWithCustomError(
        manager,
        "CallerNotVault"
      );
    });
  });
});