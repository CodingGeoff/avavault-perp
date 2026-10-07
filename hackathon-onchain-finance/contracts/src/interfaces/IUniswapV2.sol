// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev UniswapV2 兼容接口的最小子集。Avalanche Fuji 上的 LFJ(原 Trader Joe) V1、
///      Pangolin V2 等 DEX 都是这套接口的实现，因此本合约可以直接对接任意一个。
interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    /// @dev TWAP 预言机需要用到的累积价格计数器（标准 UniswapV2Pair 实现自带）
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    /// @dev 注意：LFJ(原 Trader Joe) V1 / 多数 Avalanche DEX 把这个函数命名为 `WAVAX()`
    ///      而不是以太坊生态常见的 `WETH()`，两者语义等价（原生代币的 wrapped 地址）。
    function WAVAX() external pure returns (address);

    /// @dev Avalanche 原生命名：AVAX 而不是 ETH（函数行为与 UniswapV2 的 addLiquidityETH 完全一致）
    function addLiquidityAVAX(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountAVAXMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountAVAX, uint256 liquidity);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    /// @dev Avalanche 原生命名：AVAX 而不是 ETH
    function swapExactAVAXForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapExactTokensForAVAX(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
