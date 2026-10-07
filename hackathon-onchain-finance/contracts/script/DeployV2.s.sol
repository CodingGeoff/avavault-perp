// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MultiCollateralVaultV2} from "../src/MultiCollateralVaultV2.sol";

/// @notice 部署 V2 金库，复用已经存在的 RWAToken 和 WAVAX/RWA 流动性池，
///         不重新部署代币、不重新加池子，把 gas 花在刀刃上。
/// forge script script/DeployV2.s.sol:DeployV2 --rpc-url fuji --broadcast --private-key $PRIVATE_KEY
contract DeployV2 is Script {
    address constant ROUTER = 0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901;
    address constant WAVAX = 0xd00ae08403B9bbb9124bB305C09058E32C39A48c;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);
        address rwaAddress = vm.envAddress("RWA_ADDRESS"); // 复用已部署的 RWAToken

        vm.startBroadcast(deployerKey);

        MultiCollateralVaultV2 vault = new MultiCollateralVaultV2(deployer, operator, 60);
        console.log("MultiCollateralVaultV2 deployed:", address(vault));

        vault.listCollateral(rwaAddress, ROUTER, WAVAX, 7000);
        console.log("Collateral listed, TwapOracle:", address(vault.oracles(rwaAddress)));

        uint256 depositAmount = 100 ether;
        IERC20(rwaAddress).approve(address(vault), depositAmount);
        vault.deposit(rwaAddress, depositAmount);
        console.log("Deposited RWA collateral (V2):", depositAmount);
        console.log("collateralValue() before TWAP warm-up (expect 0):", vault.collateralValue(deployer, rwaAddress));

        vm.stopBroadcast();

        console.log("---- SUMMARY ----");
        console.log("MultiCollateralVaultV2:", address(vault));
        console.log("Reused RWAToken       :", rwaAddress);
    }
}
