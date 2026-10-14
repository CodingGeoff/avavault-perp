// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 最小 ERC20 接口（本文件刻意不依赖外部库，便于独立审计与编译）
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice 抵押品估值来源：与已部署的 MultiCollateralVaultV2.totalAccountValue 对齐
///         （返回 quote 代币计价、18 位小数、已经过 TWAP 与折价处理的总估值）
interface ICollateralValuer {
    function totalAccountValue(address user) external view returns (uint256);
}

/// @notice 独立标记价预言机（与成交价解耦，避免单笔成交猎杀强平线）
interface IMarkPriceOracle {
    function getMarkPrice() external view returns (uint256);
}

/// @title PerpMarginAccount — 把 RWA 抵押估值在合约层绑成永续仓位保证金
/// @notice 设计要点：
///         1) 用户的可用保证金 = 本合约内的保证金代币余额 + 外部抵押金库
///            （MultiCollateralVaultV2）里 RWA 抵押的 TWAP 折价估值，后者按
///            治理配置的 quote 美元价折算成本合约的保证金代币数量级。
///         2) 仓位记账与撮合层（matching-engine/src/positions.ts）保持同一套
///            规则：净仓位、VWAP 入场、初始保证金 = 名义价值 / 杠杆逐笔占用、
///            平仓按比例释放并结算盈亏、反手先平后开。
///         3) 标记价只读独立预言机，不读成交价；权益跌破维持保证金可被任何人
///            强平：剩余权益扣罚金入保险基金，穿仓缺口先由保险基金兜底，
///            不足部分记坏账，永不向用户追偿至负余额。
///         4) 本合约只负责保证金与仓位风控；开仓授权沿用本项目已经验证过的
///            模式由 operator 提交（生产环境应在此之上叠加用户 EIP-712 授权，
///            与 VaultV2.settleWithAuthorization 的做法一致）。
contract PerpMarginAccount {
    // ---------------------------------------------------------------
    // 角色与配置
    // ---------------------------------------------------------------
    address public owner;
    address public operator;
    IERC20 public immutable marginToken;
    ICollateralValuer public collateralValuer;
    IMarkPriceOracle public markOracle;
    /// @notice quote 代币美元价（放大 1e6），用于把 totalAccountValue（18 位）折算成保证金代币（6 位）
    uint256 public quotePriceE6;
    uint256 public maintenanceMarginBps = 500; // 5%
    uint256 public liquidationPenaltyBps = 50; // 强平罚金：标记价名义价值的 0.5%
    uint256 public maxLeverage = 20;
    bool public paused;

    // ---------------------------------------------------------------
    // 状态
    // ---------------------------------------------------------------
    struct Position {
        int256 sizeSigned; // >0 多头，<0 空头
        uint256 entryPrice;
        uint256 marginAllocated;
    }

    mapping(address => uint256) public marginBalance; // 含被仓位占用的部分
    mapping(address => Position) public positions;
    mapping(address => int256) public realizedPnl;
    uint256 public insuranceBalance;
    uint256 public totalInsuranceCovered;
    uint256 public totalBadDebt;

    // ---------------------------------------------------------------
    // 事件与错误
    // ---------------------------------------------------------------
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event InsuranceFunded(address indexed funder, uint256 amount);
    event PositionUpdated(address indexed user, int256 sizeSigned, uint256 entryPrice, uint256 marginAllocated);
    event Liquidated(
        address indexed user,
        address indexed liquidator,
        uint256 markPrice,
        int256 pnl,
        uint256 returnedMargin,
        uint256 deficit,
        uint256 insuranceCovered,
        uint256 badDebt
    );
    event MarkOracleUpdated(address oracle);
    event OperatorUpdated(address operator);

    error NotOwner();
    error NotOperator();
    error Paused();
    error ZeroAmount();
    error InsufficientFreeMargin();
    error InsufficientMarginForPosition();
    error InvalidLeverage();
    error NotLiquidatable();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(address marginToken_, address collateralValuer_, address markOracle_, uint256 quotePriceE6_) {
        owner = msg.sender;
        operator = msg.sender;
        marginToken = IERC20(marginToken_);
        collateralValuer = ICollateralValuer(collateralValuer_);
        markOracle = IMarkPriceOracle(markOracle_);
        quotePriceE6 = quotePriceE6_;
    }

    // ---------------------------------------------------------------
    // 管理
    // ---------------------------------------------------------------
    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    function setMarkOracle(address newOracle) external onlyOwner {
        markOracle = IMarkPriceOracle(newOracle);
        emit MarkOracleUpdated(newOracle);
    }

    function setCollateralValuer(address newValuer) external onlyOwner {
        collateralValuer = ICollateralValuer(newValuer);
    }

    function setQuotePriceE6(uint256 newPriceE6) external onlyOwner {
        quotePriceE6 = newPriceE6;
    }

    function setRiskParams(uint256 maintenanceBps, uint256 penaltyBps, uint256 maxLev) external onlyOwner {
        require(maintenanceBps > 0 && maintenanceBps < 10_000, "bad maintenance bps");
        require(maxLev >= 1 && maxLev <= 100, "bad max leverage");
        maintenanceMarginBps = maintenanceBps;
        liquidationPenaltyBps = penaltyBps;
        maxLeverage = maxLev;
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
    }

    // ---------------------------------------------------------------
    // 资金进出（按实际到账记账，兼容 fee-on-transfer 代币）
    // ---------------------------------------------------------------
    function deposit(uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 before = marginToken.balanceOf(address(this));
        if (!marginToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint256 received = marginToken.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        marginBalance[msg.sender] += received;
        emit Deposited(msg.sender, received);
    }

    /// @notice 只能提取未被仓位占用的自由保证金
    function withdraw(uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (amount > freeMargin(msg.sender)) revert InsufficientFreeMargin();
        marginBalance[msg.sender] -= amount;
        if (!marginToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function fundInsurance(uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 before = marginToken.balanceOf(address(this));
        if (!marginToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint256 received = marginToken.balanceOf(address(this)) - before;
        insuranceBalance += received;
        emit InsuranceFunded(msg.sender, received);
    }

    // ---------------------------------------------------------------
    // 估值视图：RWA 抵押估值正式计入可用保证金（合约层绑定）
    // ---------------------------------------------------------------
    function rwaMarginValue(address user) public view returns (uint256) {
        if (address(collateralValuer) == address(0) || quotePriceE6 == 0) return 0;
        uint256 quoteValue18 = collateralValuer.totalAccountValue(user);
        return (quoteValue18 * quotePriceE6) / 1e18;
    }

    /// @notice 账户总权益基础 = 保证金余额 + RWA 抵押估值
    function accountValue(address user) public view returns (uint256) {
        return marginBalance[user] + rwaMarginValue(user);
    }

    function freeMargin(address user) public view returns (uint256) {
        uint256 allocated = positions[user].marginAllocated;
        uint256 value = accountValue(user);
        return value > allocated ? value - allocated : 0;
    }

    function unrealizedPnl(address user) public view returns (int256) {
        Position memory pos = positions[user];
        if (pos.sizeSigned == 0) return 0;
        uint256 mark = markOracle.getMarkPrice();
        uint256 absSize = pos.sizeSigned > 0 ? uint256(pos.sizeSigned) : uint256(-pos.sizeSigned);
        if (pos.sizeSigned > 0) return (int256(mark) - int256(pos.entryPrice)) * int256(absSize);
        return (int256(pos.entryPrice) - int256(mark)) * int256(absSize);
    }

    function equity(address user) public view returns (int256) {
        return int256(positions[user].marginAllocated) + unrealizedPnl(user);
    }

    function maintenanceMargin(address user) public view returns (uint256) {
        Position memory pos = positions[user];
        if (pos.sizeSigned == 0) return 0;
        uint256 absSize = pos.sizeSigned > 0 ? uint256(pos.sizeSigned) : uint256(-pos.sizeSigned);
        return (absSize * markOracle.getMarkPrice() * maintenanceMarginBps) / 10_000;
    }

    function isLiquidatable(address user) public view returns (bool) {
        if (positions[user].sizeSigned == 0) return false;
        return equity(user) < int256(maintenanceMargin(user));
    }

    // ---------------------------------------------------------------
    // 仓位记账（operator 提交，与撮合层 positions.ts 同一套规则）
    // ---------------------------------------------------------------
    function applyPositionDelta(address user, int256 sizeDelta, uint256 price, uint256 leverage)
        external
        onlyOperator
        whenNotPaused
    {
        if (sizeDelta == 0) revert ZeroAmount();
        if (leverage < 1 || leverage > maxLeverage) revert InvalidLeverage();
        _applyDelta(user, sizeDelta, price, leverage);
        Position memory pos = positions[user];
        emit PositionUpdated(user, pos.sizeSigned, pos.entryPrice, pos.marginAllocated);
    }

    function _applyDelta(address user, int256 sizeDelta, uint256 price, uint256 leverage) internal {
        Position storage pos = positions[user];
        bool sameDirection = pos.sizeSigned == 0 || (pos.sizeSigned > 0) == (sizeDelta > 0);

        if (sameDirection) {
            uint256 addQty = sizeDelta > 0 ? uint256(sizeDelta) : uint256(-sizeDelta);
            uint256 required = (addQty * price + leverage - 1) / leverage;
            if (required > freeMargin(user)) revert InsufficientMarginForPosition();
            uint256 openQty = pos.sizeSigned > 0 ? uint256(pos.sizeSigned) : uint256(-pos.sizeSigned);
            pos.entryPrice =
                openQty == 0 ? price : (openQty * pos.entryPrice + addQty * price) / (openQty + addQty);
            pos.marginAllocated += required;
            pos.sizeSigned += sizeDelta;
            return;
        }

        // 反方向：先平仓结算盈亏并按比例释放保证金，剩余反手开仓
        uint256 remaining = sizeDelta > 0 ? uint256(sizeDelta) : uint256(-sizeDelta);
        uint256 openQty = pos.sizeSigned > 0 ? uint256(pos.sizeSigned) : uint256(-pos.sizeSigned);
        uint256 closeQty = remaining < openQty ? remaining : openQty;
        bool isLong = pos.sizeSigned > 0;
        int256 pnl = isLong
            ? (int256(price) - int256(pos.entryPrice)) * int256(closeQty)
            : (int256(pos.entryPrice) - int256(price)) * int256(closeQty);
        _settlePnl(user, pnl);
        pos.marginAllocated -= (pos.marginAllocated * closeQty) / openQty;
        pos.sizeSigned += isLong ? -int256(closeQty) : int256(closeQty);
        remaining -= closeQty;
        if (pos.sizeSigned == 0) {
            pos.marginAllocated = 0;
            pos.entryPrice = 0;
        }
        if (remaining > 0) {
            _applyDelta(user, sizeDelta > 0 ? int256(remaining) : -int256(remaining), price, leverage);
        }
    }

    /// @notice 把已实现盈亏记到保证金余额上；亏损超过余额时差额记坏账，余额不为负
    function _settlePnl(address user, int256 pnl) internal {
        realizedPnl[user] += pnl;
        if (pnl >= 0) {
            marginBalance[user] += uint256(pnl);
        } else if (uint256(-pnl) <= marginBalance[user]) {
            marginBalance[user] -= uint256(-pnl);
        } else {
            totalBadDebt += uint256(-pnl) - marginBalance[user];
            marginBalance[user] = 0;
        }
    }

    // ---------------------------------------------------------------
    // 强平：任何人可触发，标记价只读独立预言机
    // ---------------------------------------------------------------
    function liquidate(address user) external whenNotPaused {
        Position memory pos = positions[user];
        if (pos.sizeSigned == 0) revert NotLiquidatable();
        uint256 mark = markOracle.getMarkPrice();
        int256 pnl = unrealizedPnl(user);
        int256 eq = int256(pos.marginAllocated) + pnl;
        if (eq >= int256(maintenanceMargin(user))) revert NotLiquidatable();

        uint256 absSize = pos.sizeSigned > 0 ? uint256(pos.sizeSigned) : uint256(-pos.sizeSigned);
        uint256 notionalAtMark = absSize * mark;
        uint256 returned = 0;
        uint256 deficit = 0;
        uint256 covered = 0;
        uint256 badDebt = 0;

        realizedPnl[user] += pnl;
        if (eq > 0) {
            uint256 penalty = (notionalAtMark * liquidationPenaltyBps) / 10_000;
            if (penalty > uint256(eq)) penalty = uint256(eq);
            insuranceBalance += penalty;
            returned = uint256(eq) - penalty;
            // 自由部分（余额 - 占用）原样保留，再加上退回的剩余权益
            uint256 free = marginBalance[user] > pos.marginAllocated
                ? marginBalance[user] - pos.marginAllocated
                : 0;
            marginBalance[user] = free + returned;
        } else {
            deficit = uint256(-eq);
            covered = deficit < insuranceBalance ? deficit : insuranceBalance;
            insuranceBalance -= covered;
            totalInsuranceCovered += covered;
            badDebt = deficit - covered;
            totalBadDebt += badDebt;
            uint256 free = marginBalance[user] > pos.marginAllocated
                ? marginBalance[user] - pos.marginAllocated
                : 0;
            marginBalance[user] = free;
        }

        delete positions[user];
        emit Liquidated(user, msg.sender, mark, pnl, returned, deficit, covered, badDebt);
    }
}
