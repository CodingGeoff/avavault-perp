// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RWAToken} from "../src/RWAToken.sol";
import {MultiCollateralVault} from "../src/MultiCollateralVault.sol";
import {IUniswapV2Router02, IUniswapV2Factory} from "../src/interfaces/IUniswapV2.sol";

/// forge script script/Deploy.s.sol:Deploy --rpc-url fuji --broadcast --private-key $PRIVATE_KEY
contract Deploy is Script {
    address constant ROUTER = 0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901;
    address constant FACTORY = 0xF5c7d9733e5f53abCC1695820c4818C59B457C2C;
    address constant WAVAX = 0xd00ae08403B9bbb9124bB305C09058E32C39A48c;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);

        uint256 liquidityAvax = vm.envOr("LIQUIDITY_AVAX", uint256(2 ether));
        uint256 liquidityRwa = vm.envOr("LIQUIDITY_RWA", uint256(1_000 ether));

        vm.startBroadcast(deployerKey);

        RWAToken rwa = new RWAToken("Shibuya Tower Rental Rights", "SRT-RWA", 1_000_000 ether);
        console.log("RWAToken deployed:", address(rwa));

        MultiCollateralVault vault = new MultiCollateralVault(deployer, operator);
        console.log("MultiCollateralVault deployed:", address(vault));

        vault.listCollateral(address(rwa), ROUTER, WAVAX, 7000); // 70% haircut

        rwa.approve(ROUTER, liquidityRwa);
        IUniswapV2Router02(ROUTER).addLiquidityAVAX{value: liquidityAvax}(
            address(rwa), liquidityRwa, 0, 0, deployer, block.timestamp + 3600
        );
        address pair = IUniswapV2Factory(FACTORY).getPair(address(rwa), WAVAX);
        console.log("WAVAX/RWA pair:", pair);

        // 演示一次真实存款
        uint256 depositAmount = 100 ether;
        rwa.approve(address(vault), depositAmount);
        vault.deposit(address(rwa), depositAmount);
        console.log("Deposited RWA collateral:", depositAmount);
        console.log("Collateral value (AVAX terms):", vault.collateralValue(deployer, address(rwa)));

        vm.stopBroadcast();

        console.log("---- SUMMARY ----");
        console.log("RWAToken             :", address(rwa));
        console.log("MultiCollateralVault  :", address(vault));
        console.log("WAVAX/RWA Pair        :", pair);
    }
}
