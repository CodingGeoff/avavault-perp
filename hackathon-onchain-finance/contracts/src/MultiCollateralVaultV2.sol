// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IUniswapV2Router02, IUniswapV2Factory} from "./interfaces/IUniswapV2.sol";
import {TwapOracle} from "./TwapOracle.sol";

/// @title MultiCollateralVaultV2 — MultiCollateralVault 的加固版本
/// @notice 相对 V1（保留在仓库中作为问题记录/回归对照）修复了两个和 Task3/Task7 里发现的
///         真实问题完全同源的漏洞（这个合约本来就是那两个模块拼出来的，风险自然也是共享的）：
///
///   1. **抵押品估值可被同笔交易操纵**（对应 Task3 Finding #2 / DexPricedSaleV2 的修复）：
///      V1 的 `collateralValue()` 直接读 `router.getAmountsOut()` 的瞬时储备价格——攻击者理论上可以
///      用闪电贷把 RWA 抵押品的池内价格瞬间拉高，在同一笔交易里把被高估的抵押品去借出/开出更大的仓位，
///      再在同一笔交易结束前把价格套利打回去。**修复**：估值改为读取 `TwapOracle` 的时间加权平均价，
///      拉爆同一区块的瞬时价格对这里毫无用处。
///
///   2. **operator 权限过于集中**（对应 Task7 Finding #4 / VaultV2 的修复）：`settle()` 只要求调用者
///      是 operator，一旦热钱包泄露就能任意重分配用户资产。**修复**：改成 `settleWithAuthorization`，
///      需要被扣款方用自己的私钥签一份 EIP-712 授权，限定最大可转出金额和有效期。
contract MultiCollateralVaultV2 is Ownable, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "SettlementAuthorization(address from,address token,uint256 maxAmount,uint256 nonce,uint256 deadline)"
    );

    struct CollateralConfig {
        bool active;
        address quoteToken;
        uint16 haircutBps;
    }

    mapping(address => CollateralConfig) public collateralConfigs;
    mapping(address => TwapOracle) public oracles;
    address[] public supportedCollaterals;

    mapping(address => mapping(address => uint256)) public rawBalance;

    mapping(address => mapping(address => mapping(uint256 => uint256))) public usedAmount; // user => token => nonce => used
    mapping(address => mapping(address => mapping(uint256 => bool))) public cancelledAuthorization;

    address public operator;
    uint256 public immutable twapMinPeriod;

    event CollateralListed(address indexed token, address router, address quoteToken, uint16 haircutBps, address oracle);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Settled(address indexed from, address indexed to, address indexed token, uint256 amount, bytes32 tradeRef, uint256 nonce);
    event AuthorizationCancelled(address indexed from, address indexed token, uint256 indexed nonce);
    event OperatorUpdated(address indexed newOperator);

    error CollateralNotActive();
    error ZeroAmount();
    error InsufficientBalance();
    error NotOperator();
    error AuthorizationExpired();
    error AuthorizationCancelledError();
    error AuthorizationExceeded();
    error InvalidSignature();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address initialOwner, address initialOperator, uint256 twapMinPeriod_)
        Ownable(initialOwner)
        EIP712("MultiCollateralVault", "2")
    {
        operator = initialOperator;
        twapMinPeriod = twapMinPeriod_;
    }

    // ---------------------------------------------------------------
    // 管理员：登记可以作为保证金的资产，自动为它部署一个 TwapOracle
    // ---------------------------------------------------------------
    function listCollateral(address token, address router, address quoteToken, uint16 haircutBps) external onlyOwner {
        require(haircutBps > 0 && haircutBps <= 10_000, "invalid haircut");

        address factory = IUniswapV2Router02(router).factory();
        address pair = IUniswapV2Factory(factory).getPair(token, quoteToken);
        require(pair != address(0), "pair does not exist yet");

        bool isNew = collateralConfigs[token].quoteToken == address(0);
        collateralConfigs[token] = CollateralConfig({active: true, quoteToken: quoteToken, haircutBps: haircutBps});
        oracles[token] = new TwapOracle(pair, twapMinPeriod);
        if (isNew) supportedCollaterals.push(token);

        emit CollateralListed(token, router, quoteToken, haircutBps, address(oracles[token]));
    }

    function setCollateralActive(address token, bool active) external onlyOwner {
        collateralConfigs[token].active = active;
    }

    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    // ---------------------------------------------------------------
    // 用户存取
    // ---------------------------------------------------------------
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (!collateralConfigs[token].active) revert CollateralNotActive();
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;

        rawBalance[msg.sender][token] += received;
        pokeOracle(token); // 尽力刷新 TWAP 窗口，不影响本笔存款

        emit Deposited(msg.sender, token, received);
    }

    function withdraw(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = rawBalance[msg.sender][token];
        if (bal < amount) revert InsufficientBalance();

        rawBalance[msg.sender][token] = bal - amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice 任何人都可以调用，尽力把某个抵押品的 TWAP 窗口向前推进一格
    function pokeOracle(address token) public returns (bool) {
        TwapOracle oracle = oracles[token];
        if (address(oracle) == address(0)) return false;
        return oracle.update();
    }

    // ---------------------------------------------------------------
    // 签名授权约束下的链上净额结算
    // ---------------------------------------------------------------
    function cancelAuthorization(address token, uint256 nonce) external {
        cancelledAuthorization[msg.sender][token][nonce] = true;
        emit AuthorizationCancelled(msg.sender, token, nonce);
    }

    function hashAuthorization(address from, address token, uint256 maxAmount, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(AUTHORIZATION_TYPEHASH, from, token, maxAmount, nonce, deadline));
        return _hashTypedDataV4(structHash);
    }

    function settleWithAuthorization(
        address from,
        address to,
        address token,
        uint256 amount,
        bytes32 tradeRef,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (cancelledAuthorization[from][token][nonce]) revert AuthorizationCancelledError();

        bytes32 digest = hashAuthorization(from, token, maxAmount, nonce, deadline);
        address signer = ECDSA.recover(digest, signature);
        if (signer != from) revert InvalidSignature();

        uint256 newUsed = usedAmount[from][token][nonce] + amount;
        if (newUsed > maxAmount) revert AuthorizationExceeded();
        usedAmount[from][token][nonce] = newUsed;

        uint256 bal = rawBalance[from][token];
        if (bal < amount) revert InsufficientBalance();
        rawBalance[from][token] = bal - amount;
        rawBalance[to][token] += amount;

        emit Settled(from, to, token, amount, tradeRef, nonce);
    }

    // ---------------------------------------------------------------
    // 只读：账户在所有抵押品类型下的美元计价总市值（用于保证金率计算）——现在锚定 TWAP
    // ---------------------------------------------------------------

    /// @notice 单个资产按 TWAP 折算成"以 quoteToken 计价、含折价率"的价值。
    ///         如果这个抵押品的 TWAP 窗口还没有热身好（刚上线/刚换了个池子），保守地按 0 计算，
    ///         而不是退回瞬时价格——宁可暂时低估保证金，也不要在没有可信历史价格时接受一个
    ///         可能被操纵的数字。
    function collateralValue(address user, address token) public view returns (uint256 valueInQuote18) {
        uint256 amount = rawBalance[user][token];
        if (amount == 0) return 0;

        CollateralConfig memory cfg = collateralConfigs[token];
        if (!cfg.active) return 0;

        TwapOracle oracle = oracles[token];
        if (address(oracle) == address(0) || !oracle.isReady()) return 0;

        uint256 rawQuoteValue = oracle.consult(token, amount);
        return (rawQuoteValue * cfg.haircutBps) / 10_000;
    }

    function totalAccountValue(address user) external view returns (uint256 total) {
        uint256 len = supportedCollaterals.length;
        for (uint256 i = 0; i < len; i++) {
            total += collateralValue(user, supportedCollaterals[i]);
        }
    }

    function supportedCollateralsCount() external view returns (uint256) {
        return supportedCollaterals.length;
    }
}
