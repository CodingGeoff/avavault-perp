// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PerpMarginAccount} from "../src/PerpMarginAccount.sol";
import {SimpleMarkOracle} from "../src/SimpleMarkOracle.sol";

/// @notice 部署合约层仓位保证金系统：先部署一个治理设定的标记价预言机，
///         再部署 PerpMarginAccount 并绑定已上线的 MultiCollateralVaultV2。
///
/// 用法（在 contracts/ 目录下）：
///   cp .env.example .env   # 填 PRIVATE_KEY（部署钱包，需要少量 Fuji 测试 AVAX）
///   source .env
///   forge script script/DeployPerpMarginAccount.s.sol:DeployPerpMarginAccount \
///     --rpc-url https://api.avax-test.network/ext/bc/C/rpc \
///     --broadcast --private-key $PRIVATE_KEY
///
/// 部署参数可用环境变量覆盖（默认值对应当前 Fuji 部署）：
///   MARGIN_TOKEN            保证金代币（默认 MockUSDC）
///   COLLATERAL_VAULT        已部署的 MultiCollateralVaultV2
///   QUOTE_PRICE_E6          quote 代币美元价（放大 1e6，如 $12.34 -> 12340000），部署时按当时市价填
///   INITIAL_MARK_PRICE      标记价初值（与交易品种的参考价同量纲）
contract DeployPerpMarginAccount is Script {
    function run() external {
        address marginToken = vm.envOr("MARGIN_TOKEN", address(0x206d1B4D35c1f081C82939F1d97A05B5cb5BEF93));
        address collateralVault = vm.envOr("COLLATERAL_VAULT", address(0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884));
        uint256 quotePriceE6 = vm.envOr("QUOTE_PRICE_E6", uint256(35_000_000));
        uint256 initialMarkPrice = vm.envOr("INITIAL_MARK_PRICE", uint256(2500));

        vm.startBroadcast();
        SimpleMarkOracle oracle = new SimpleMarkOracle(initialMarkPrice);
        PerpMarginAccount account = new PerpMarginAccount(marginToken, collateralVault, address(oracle), quotePriceE6);
        vm.stopBroadcast();

        console.log("SimpleMarkOracle:", address(oracle));
        console.log("PerpMarginAccount:", address(account));
        console.log("CollateralVault (MultiCollateralVaultV2):", collateralVault);
        console.log("MarginToken:", marginToken);
    }
}
