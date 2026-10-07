// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 仅用于测试：每次转账收取 2% "税"，销毁掉，用来复现/验证
///         SECURITY_REVIEW.md Finding #1（fee-on-transfer token 的记账风险）。
contract FeeOnTransferToken is ERC20 {
    uint256 public constant FEE_BPS = 200; // 2%

    constructor(uint256 initialSupply) ERC20("Fee On Transfer Token", "FOT") {
        _mint(msg.sender, initialSupply);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * FEE_BPS) / 10_000;
        super._update(from, address(0xdead), fee); // 销毁手续费
        super._update(from, to, value - fee);
    }
}
