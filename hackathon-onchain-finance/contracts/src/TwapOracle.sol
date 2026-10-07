// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Pair} from "./interfaces/IUniswapV2.sol";

/// @title TwapOracle — 基于 UniswapV2 累积价格计数器的时间加权平均价格预言机
/// @notice 这是 SECURITY_REVIEW.md Finding #2 的正式修复：`DexPricedSale`（V1）直接读取
///         `router.getAmountsOut()` 得到的瞬时储备价格，攻击者可以在**同一笔交易**里先用闪电贷
///         把价格砸到有利于自己的方向、紧接着调用 `buy()`，因为"读取当前价格"和"执行交易"发生在
///         同一笔原子交易里，`maxPriceImpactBps` 这种"跟自己比较"的保护形同虚设。
///
///         真正的修复思路（照搬 Uniswap V2 官方 oracle 范例 ExampleOracleSimple 的做法）：
///         记录两个时间点的 `price0CumulativeLast`/`price1CumulativeLast`，两者之差除以经过的
///         秒数，就是这段时间窗口内的**时间加权平均价格**。只要这个窗口跨越了不止一个区块
///         （`minPeriod` 保证了这一点），攻击者就不可能在一笔交易内把它拉到自己想要的方向——
///         就算他确实操纵了价格，这个操纵瞬间在整个窗口里占比极小，会被摊薄到几乎不影响均价。
contract TwapOracle {
    uint256 private constant Q112 = 2 ** 112;

    IUniswapV2Pair public immutable pair;
    address public immutable token0;
    address public immutable token1;

    /// @notice 两次 `update()` 之间必须经过的最短秒数，防止用一个"窗口"极短、几乎等同于瞬时价格
    ///         的更新来伪造"TWAP"。生产环境建议设置成 10~30 分钟；本项目部署在 Fuji 测试网，
    ///         为了能在合理时间内做出真实的链上演示，构造时传入了一个更短的周期（见部署脚本注释）。
    uint256 public immutable minPeriod;

    uint256 public price0CumulativeLastSnapshot;
    uint256 public price1CumulativeLastSnapshot;
    uint32 public blockTimestampLastSnapshot;

    /// @notice 最近一次成功计算出的时间加权平均价格，Q112 定点数
    uint256 public price0Average; // token1 相对 token0 的价格
    uint256 public price1Average; // token0 相对 token1 的价格
    uint32 public lastWindowElapsed;

    event TwapUpdated(uint256 price0Average, uint256 price1Average, uint32 windowElapsed);

    error PeriodNotElapsed();
    error StaleWindow();
    error InvalidToken();

    constructor(address pair_, uint256 minPeriod_) {
        pair = IUniswapV2Pair(pair_);
        token0 = pair.token0();
        token1 = pair.token1();
        minPeriod = minPeriod_;

        (,, uint32 ts) = pair.getReserves();
        price0CumulativeLastSnapshot = pair.price0CumulativeLast();
        price1CumulativeLastSnapshot = pair.price1CumulativeLast();
        blockTimestampLastSnapshot = ts;
    }

    /// @notice 任何人都可以调用，把 checkpoint 向前推进一格；距离上次 checkpoint 不足
    ///         `minPeriod` 秒时不做任何事并返回 false（不 revert，方便业务合约"尽力刷新"）。
    function update() public returns (bool updated) {
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        uint32 timeElapsed;
        unchecked {
            timeElapsed = blockTimestamp - blockTimestampLastSnapshot;
        }
        if (timeElapsed < minPeriod) return false;

        (uint256 price0Cumulative, uint256 price1Cumulative) = _currentCumulativePrices(blockTimestamp);

        unchecked {
            price0Average = (price0Cumulative - price0CumulativeLastSnapshot) / timeElapsed;
            price1Average = (price1Cumulative - price1CumulativeLastSnapshot) / timeElapsed;
        }

        price0CumulativeLastSnapshot = price0Cumulative;
        price1CumulativeLastSnapshot = price1Cumulative;
        blockTimestampLastSnapshot = blockTimestamp;
        lastWindowElapsed = timeElapsed;

        emit TwapUpdated(price0Average, price1Average, timeElapsed);
        return true;
    }

    /// @dev 把 pair 里存的累积价格外推到"当前这一刻"——如果本区块 pair 自己没有发生
    ///      mint/burn/swap（`price0CumulativeLast` 还停留在上一次变动时的值），就要用当前储备量
    ///      手动补上从那时到现在这段时间的贡献，逻辑照抄 Uniswap V2 的 `UniswapV2OracleLibrary`。
    function _currentCumulativePrices(uint32 blockTimestamp)
        internal
        view
        returns (uint256 price0Cumulative, uint256 price1Cumulative)
    {
        price0Cumulative = pair.price0CumulativeLast();
        price1Cumulative = pair.price1CumulativeLast();
        (uint112 reserve0, uint112 reserve1, uint32 pairTimestampLast) = pair.getReserves();

        if (pairTimestampLast != blockTimestamp && reserve0 > 0 && reserve1 > 0) {
            uint32 extra;
            unchecked {
                extra = blockTimestamp - pairTimestampLast;
            }
            price0Cumulative += (uint256(reserve1) * Q112 / reserve0) * extra;
            price1Cumulative += (uint256(reserve0) * Q112 / reserve1) * extra;
        }
    }

    /// @notice 只读预览：如果现在调用 `update()`，会不会成功、以及成功的话平均价是多少。
    ///         给前端/业务合约在真正调用 `update()` 之前先判断要不要等。
    function previewUpdate() external view returns (bool wouldUpdate, uint256 previewPrice0Average, uint256 previewPrice1Average) {
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        uint32 timeElapsed;
        unchecked {
            timeElapsed = blockTimestamp - blockTimestampLastSnapshot;
        }
        if (timeElapsed < minPeriod) return (false, price0Average, price1Average);

        (uint256 price0Cumulative, uint256 price1Cumulative) = _currentCumulativePrices(blockTimestamp);
        unchecked {
            previewPrice0Average = (price0Cumulative - price0CumulativeLastSnapshot) / timeElapsed;
            previewPrice1Average = (price1Cumulative - price1CumulativeLastSnapshot) / timeElapsed;
        }
        wouldUpdate = true;
    }

    /// @notice 询价：`tokenIn` 数量为 `amountIn` 时，按最近一次算出的 TWAP 能兑换多少另一种代币。
    function consult(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut) {
        if (price0Average == 0 && price1Average == 0) revert StaleWindow();
        if (tokenIn == token0) {
            amountOut = (price0Average * amountIn) / Q112;
        } else if (tokenIn == token1) {
            amountOut = (price1Average * amountIn) / Q112;
        } else {
            revert InvalidToken();
        }
    }

    /// @notice 当前是否已经有一个有效的 TWAP 窗口可用
    function isReady() external view returns (bool) {
        return price0Average != 0 || price1Average != 0;
    }
}
