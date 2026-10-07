// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title VaultV2 — Vault 的加固版本，修复 SECURITY_REVIEW.md Finding #4
/// @notice V1（`Vault.sol`，继续保留在仓库中作为问题记录/回归对照）里的 `settle()` 只要求
///         `msg.sender == operator`，operator 可以在任意两个已存款地址之间任意转移余额。
///         这在文档里被评估为"信息级"风险，因为 operator 不能凭空铸币，只能重新分配已有资金——
///         但"重新分配已有资金"仍然是一个真实的攻击面：一旦 operator 私钥泄露，攻击者可以在一笔
///         交易里把任何用户的全部余额转给自己。
///
///         真正的修复：`settleWithAuthorization` 要求被扣款的一方（`from`）事先用自己的私钥签署一份
///         EIP-712 授权，声明"在到期时间之前，最多同意从我账上转出 `maxAmount`"。operator 依然负责
///         提交结算交易（因为撮合结果本身是链下产生的，不可能要求用户对每一笔部分成交都在线签名），
///         但现在它能转移的金额**上限由用户自己的签名圈定**，超出授权范围的部分一律 revert。
///         用户还可以随时 `cancelAuthorization` 主动作废一个还没花完的授权，进一步收窄攻击窗口。
///
///         这样即使 operator 热钱包私钥泄露，最坏情况也从"可以转走任意用户的全部余额"收窄成
///         "只能在每个用户自己签名同意的额度和有效期内转账"——和 V1 的信任模型相比是本质提升。
///
///         有意的设计取舍（照实记录，不回避）：签名只圈定"最多能转出多少、多久内有效"，**不圈定
///         具体的收款地址**。这是因为撮合引擎是一个真实的订单簿：下单时你不可能预先知道最终会和
///         哪个具体地址成交。真实世界的链下撮合/链上结算系统（如 0x Protocol、dYdX v3）也是同样的
///         取舍——签名约束的是"数量和时效"而不是"对手方"，这是订单簿模型的固有特性，不是本实现的疏漏。
contract VaultV2 is Ownable, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    bytes32 public constant AUTHORIZATION_TYPEHASH =
        keccak256("SettlementAuthorization(address from,uint256 maxAmount,uint256 nonce,uint256 deadline)");

    IERC20 public immutable collateralToken;
    address public operator;

    mapping(address => uint256) public balanceOf;
    uint256 public perUserCap;

    /// @notice 每个 (用户, nonce) 组合已经被实际结算掉的累计金额，不能超过该 nonce 对应签名里的 maxAmount
    mapping(address => mapping(uint256 => uint256)) public usedAmount;
    /// @notice 用户可以主动作废一个还没被（或没被完全）使用的授权
    mapping(address => mapping(uint256 => bool)) public cancelledAuthorization;

    event Deposited(address indexed user, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed user, uint256 amount, uint256 newBalance);
    event Settled(address indexed from, address indexed to, uint256 amount, bytes32 indexed tradeRef, uint256 nonce);
    event AuthorizationCancelled(address indexed from, uint256 indexed nonce);
    event OperatorUpdated(address indexed newOperator);
    event PerUserCapUpdated(uint256 newCap);

    error CapExceeded();
    error InsufficientBalance();
    error NotOperator();
    error ZeroAmount();
    error AuthorizationExpired();
    error AuthorizationCancelledError();
    error AuthorizationExceeded();
    error InvalidSignature();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address collateralToken_, address initialOwner, address initialOperator)
        Ownable(initialOwner)
        EIP712("MiniDexVault", "2")
    {
        collateralToken = IERC20(collateralToken_);
        operator = initialOperator;
    }

    // ---------------------------------------------------------------
    // 用户自助存取（和 V1 完全一致，包括 Finding #1 的 fee-on-transfer 修复）
    // ---------------------------------------------------------------
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = collateralToken.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();

        uint256 newBalance = balanceOf[msg.sender] + received;
        if (perUserCap != 0 && newBalance > perUserCap) revert CapExceeded();

        balanceOf[msg.sender] = newBalance;
        emit Deposited(msg.sender, received, newBalance);
    }

    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance();

        balanceOf[msg.sender] = bal - amount;
        collateralToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, bal - amount);
    }

    // ---------------------------------------------------------------
    // 签名授权约束下的链上净额结算
    // ---------------------------------------------------------------

    /// @notice 用户提前撤销一个尚未用完的授权（比如撤单时），进一步缩小 operator 能动用的敞口
    function cancelAuthorization(uint256 nonce) external {
        cancelledAuthorization[msg.sender][nonce] = true;
        emit AuthorizationCancelled(msg.sender, nonce);
    }

    function hashAuthorization(address from, uint256 maxAmount, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(AUTHORIZATION_TYPEHASH, from, maxAmount, nonce, deadline));
        return _hashTypedDataV4(structHash);
    }

    /// @param from 被扣款方，必须是 `signature` 的签署人
    /// @param to 收款方（订单簿模型下无法提前用签名圈定具体对手方，见合约头部注释）
    /// @param amount 本次结算金额
    /// @param tradeRef 链下撮合引擎里的 trade id（哈希后存证）
    /// @param maxAmount `from` 在这个 nonce 下签名同意的最大累计可转出金额
    /// @param nonce `from` 自己选的这份授权的唯一标识（通常对应一个链下订单 id），同一个 nonce
    ///        可以被多笔部分成交重复使用，只要累计不超过 `maxAmount`
    /// @param deadline 授权过期时间
    /// @param signature `from` 对 `hashAuthorization(from, maxAmount, nonce, deadline)` 的 EIP-712 签名
    function settleWithAuthorization(
        address from,
        address to,
        uint256 amount,
        bytes32 tradeRef,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (cancelledAuthorization[from][nonce]) revert AuthorizationCancelledError();

        bytes32 digest = hashAuthorization(from, maxAmount, nonce, deadline);
        address signer = ECDSA.recover(digest, signature);
        if (signer != from) revert InvalidSignature();

        uint256 newUsed = usedAmount[from][nonce] + amount;
        if (newUsed > maxAmount) revert AuthorizationExceeded();
        usedAmount[from][nonce] = newUsed;

        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;

        emit Settled(from, to, amount, tradeRef, nonce);
    }

    // ---------------------------------------------------------------
    // 管理员操作
    // ---------------------------------------------------------------
    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    function setPerUserCap(uint256 newCap) external onlyOwner {
        perUserCap = newCap;
        emit PerUserCapUpdated(newCap);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
