// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 6 位小数的测试网 USDC，用作 Mini-Perp-Dex 的保证金资产。
contract MockUSDC is ERC20 {
    constructor(uint256 initialSupply) ERC20("Mock USD Coin", "mUSDC") {
        _mint(msg.sender, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice 任何人都可以给自己领取测试币，方便演示端到端流程（仅测试网）
    function faucet(uint256 amount) external {
        require(amount <= 100_000 * 10 ** 6, "max 100,000 mUSDC per call");
        _mint(msg.sender, amount);
    }
}
