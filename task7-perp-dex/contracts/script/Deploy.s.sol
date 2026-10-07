// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {Vault} from "../src/Vault.sol";

/// @notice 一次性部署 Mini-Perp-Dex 需要的 3 个合约，并完成一笔真实 deposit 交易，
///         满足 Task7 必做项②「提交 3 个已部署的合约地址 + 一笔真实 deposit」。
/// forge script script/Deploy.s.sol:Deploy --rpc-url fuji --broadcast --private-key $PRIVATE_KEY
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        // operator 默认等于部署者自己（本地/演示环境）；生产环境应换成撮合引擎专用的热钱包地址
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);

        vm.startBroadcast(deployerKey);

        MockUSDC usdc = new MockUSDC(1_000_000 * 10 ** 6);
        console.log("MockUSDC deployed:", address(usdc));

        MarketRegistry registry = new MarketRegistry(deployer);
        registry.listMarket("AVAX-PERP", address(0), 20, 500); // priceOracle 先占位，可后续接 Task3 的价格合约
        console.log("MarketRegistry deployed:", address(registry));

        Vault vault = new Vault(address(usdc), deployer, operator);
        console.log("Vault deployed:", address(vault));

        // 完成一笔真实 deposit，交易哈希会打印在 broadcast 日志里
        uint256 depositAmount = 1_000 * 10 ** 6;
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        console.log("Deposited", depositAmount, "mUSDC into Vault, balance:", vault.balanceOf(deployer));

        vm.stopBroadcast();

        console.log("---- SUMMARY (3 contracts) ----");
        console.log("MockUSDC       :", address(usdc));
        console.log("MarketRegistry :", address(registry));
        console.log("Vault          :", address(vault));
    }
}
