require("dotenv").config({ quiet: true });
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      // X Layer migrated from Polygon zkEVM to OP Stack (October 2025). OP Stack
      // is EVM-equivalent. paris is the conservative safe target — do not
      // upgrade to shanghai or cancun without explicit X Layer confirmation.
      evmVersion: "paris",
    },
  },
  networks: {
    // Chain IDs and endpoint options per X Layer network information:
    // https://web3.okx.com/onchainos/dev-docs/xlayer/developer/build-on-xlayer/network-information
    xlayer: {
      chainId: 196,
      // `|| ""` only satisfies Hardhat's config validation, which requires a
      // string on every command (including `compile`). No URL is hardcoded;
      // an unset variable leaves this empty and fails at connect time, not here.
      url: process.env.X_LAYER_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    xlayerTestnet: {
      chainId: 1952,
      url: process.env.X_LAYER_TESTNET_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
