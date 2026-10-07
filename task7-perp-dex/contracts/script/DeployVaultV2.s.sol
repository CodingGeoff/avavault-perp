// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VaultV2} from "../src/VaultV2.sol";

/// @notice 部署加固版 VaultV2，**复用 V1 部署脚本已经创建好的 MockUSDC**，不需要重新铸造/铺设抵押代币，
///         只需要部署一个新的金库合约，gas 成本很小。
///
/// 用法：
///   USDC_ADDRESS=0x... forge script script/DeployVaultV2.s.sol:DeployVaultV2 \
///     --rpc-url fuji --broadcast --private-key $PRIVATE_KEY
contract DeployVaultV2 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);
        address usdcAddr = vm.envAddress("USDC_ADDRESS");

        vm.startBroadcast(deployerKey);

        VaultV2 vaultV2 = new VaultV2(usdcAddr, deployer, operator);
        console.log("VaultV2 deployed:", address(vaultV2));

        vm.stopBroadcast();

        console.log("---- SUMMARY ----");
        console.log("Reused MockUSDC :", usdcAddr);
        console.log("VaultV2         :", address(vaultV2));
        console.log("operator        :", operator);
    }
}
