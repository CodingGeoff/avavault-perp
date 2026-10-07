#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 10 张 1920x1080 的视频幻灯片（PNG），风格统一（Avalanche 红 + 深色背景，
和 demo 页面同一套配色），其中 5 张纯文字/图示，5 张嵌入真实截图。
同一份数据也会被 build_pptx.py 复用，生成可编辑的 .pptx。
用法: python3 build_slides.py [zh|en]
"""
import os
import sys
import textwrap
from PIL import Image, ImageDraw, ImageFont

LANG = sys.argv[1] if len(sys.argv) > 1 else "zh"

W, H = 1920, 1080
BG = (11, 13, 16)
CARD = (21, 24, 28)
RED = (232, 65, 66)
TEXT = (238, 238, 238)
MUTED = (154, 164, 175)
GREEN = (46, 204, 113)

FONT_DIR = "/usr/share/fonts"
def find_font(candidates):
    for root, _, files in os.walk(FONT_DIR):
        for f in files:
            for c in candidates:
                if c.lower() in f.lower():
                    return os.path.join(root, f)
    return None

CJK_BOLD = find_font(["NotoSansCJK-Bold", "NotoSansSC-Bold", "WenQuanYi"]) or find_font(["NotoSansCJK"])
CJK_REG = find_font(["NotoSansCJK-Regular", "NotoSansSC-Regular", "WenQuanYi"]) or CJK_BOLD
LATIN_BOLD = find_font(["DejaVuSans-Bold"])
LATIN_REG = find_font(["DejaVuSans.ttf"]) or find_font(["DejaVuSans-Regular"])

def font(size, bold=False, lang=LANG):
    path = None
    if lang == "zh":
        path = CJK_BOLD if bold else CJK_REG
    if not path:
        path = LATIN_BOLD if bold else LATIN_REG
    if not path:
        return ImageFont.load_default()
    return ImageFont.truetype(path, size)

OUT_DIR = f"./slides_{LANG}"
os.makedirs(OUT_DIR, exist_ok=True)
SCREEN_DIR = "./raw_screenshots"

def base_canvas():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # 顶部细红线
    d.rectangle([0, 0, W, 6], fill=RED)
    return img, d

def wrap_text(d, text, f, max_width):
    lines = []
    for para in text.split("\n"):
        words = list(para) if LANG == "zh" else para.split(" ")
        sep = "" if LANG == "zh" else " "
        cur = ""
        for w in words:
            trial = cur + sep + w if cur else w
            if d.textlength(trial, font=f) <= max_width:
                cur = trial
            else:
                if cur:
                    lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
    return lines

def fit_title(d, text, max_width, start_size, min_size, bold=True, step=2):
    """自动把标题字号缩小到能在 max_width 内单行放下；如果缩到 min_size 还放不下，
    就在 min_size 下按 wrap_text 换行。返回 (font, size, lines)。"""
    size = start_size
    while size > min_size:
        f = font(size, bold)
        if d.textlength(text, font=f) <= max_width:
            return f, size, [text]
        size -= step
    f = font(min_size, bold)
    if d.textlength(text, font=f) <= max_width:
        return f, min_size, [text]
    return f, min_size, wrap_text(d, text, f, max_width)


def draw_title_bar(d, kicker, title):
    d.text((120, 70), kicker, font=font(28, True), fill=RED)
    f, size, lines = fit_title(d, title, W - 240, 56, 38)
    y = 110
    for ln in lines:
        d.text((120, y), ln, font=f, fill=TEXT)
        y += int(size * 1.2)

def draw_footer(d, page, total):
    d.text((120, H - 70), "AvaVault Perp · Avalanche Buildathon · Onchain Finance Track", font=font(22), fill=MUTED)
    txt = f"{page}/{total}"
    tw = d.textlength(txt, font=font(22))
    d.text((W - 120 - tw, H - 70), txt, font=font(22), fill=MUTED)

def paste_screenshot(img, path, box):
    shot = Image.open(path).convert("RGB")
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    ratio = min(bw / shot.width, bh / shot.height)
    nw, nh = int(shot.width * ratio), int(shot.height * ratio)
    shot = shot.resize((nw, nh))
    frame = Image.new("RGB", (nw + 24, nh + 24), (35, 39, 44))
    frame.paste(shot, (12, 12))
    fx = x0 + (bw - frame.width) // 2
    fy = y0 + (bh - frame.height) // 2
    img.paste(frame, (fx, fy))

T = {
  "zh": {
    "s1_kicker": "AVALANCHE BUILDATHON · 链上金融赛道",
    "s1_title": "AvaVault Perp",
    "s1_sub": "把\"收租金的房子\"变成\"能交易永续合约的保证金\"",
    "s1_tags": ["RWA 代币化", "DEX 实时定价", "永续合约保证金"],
    "s2_kicker": "问题",
    "s2_title": "真实世界资产，大多数时候是\"死资产\"",
    "s2_body": [
      "RWA Token 持有者只能\"拿着等分红\"，流动性差、用途单一。",
      "永续合约交易者的保证金必须是稳定币/主流资产。",
      "收益类资产要先变现才能用作保证金——变现意味着\n卖出，失去持有收益权的敞口。",
    ],
    "s3_kicker": "洞察 → 方案",
    "s3_title": "只要有一个 DEX 交易对，就有一个可编程的价格",
    "s3_flow": ["存入 RWA Token", "DEX 实时估值", "打折计入保证金", "开永续合约仓位"],
    "s4_kicker": "技术融合",
    "s4_title": "三层链上金融组件，拼成一套完整系统",
    "s4_items": [
      ("预言机层", "DEX Oracle", "LFJ V1 实时报价，getAmountsOut 链上定价"),
      ("资产层", "RWA Token", "房地产租金收益权，AccessControl 权限体系"),
      ("结算层", "Perp Vault", "链下撮合 + 链上净额结算的永续合约引擎"),
    ],
    "s5_kicker": "真实部署证明 · 非截图摆拍",
    "s5_title": "MultiCollateralVault 已真实部署到 Fuji 测试网",
    "s5_cap": "Snowtrace 可直接验证：合约创建交易 + 3 笔真实链上交互",
    "s6_kicker": "真实链上交易",
    "s6_title": "存入保证金 → 签名授权结算，全部可验证",
    "s6_cap_left": "100 枚 RWA Token 真实存入金库作为保证金",
    "s6_cap_right": "EIP-712 签名授权，operator 代为完成真实结算",
    "s7_kicker": "实时仪表盘",
    "s7_title": "没有一个数字是写死的",
    "s7_cap": "每次刷新都重新读取 Fuji 链上状态：供应量、托管余额、DEX 储备量估值",
    "s8_kicker": "端到端 Demo",
    "s8_title": "永续合约交易引擎，真实跑通",
    "s8_cap": "真实登录签名 · 真实订单簿深度 · 真实下单回报",
    "s9_kicker": "为什么是 Avalanche",
    "s9_title": "亚秒级确认 + 极低 Gas，让高频链上定价成为可能",
    "s9_items": [
      "真实交易手续费：约 0.0001 AVAX 量级",
      "DEX 实时价格可以被频繁、低成本地读取",
      "C-Chain 完全 EVM 兼容，Solidity 直接复用",
    ],
    "s10_kicker": "AvaVault Perp",
    "s10_title": "让沉睡的真实世界资产，重新流动起来",
    "s10_sub": "感谢观看 · 我们在 Avalanche 上，构建下一个链上金融的可能",
  },
  "en": {
    "s1_kicker": "AVALANCHE BUILDATHON · ONCHAIN FINANCE TRACK",
    "s1_title": "AvaVault Perp",
    "s1_sub": "Turn a rent-collecting property into perpetual-trading margin",
    "s1_tags": ["RWA Tokenization", "DEX Price Oracle", "Perpetual Margin"],
    "s2_kicker": "THE PROBLEM",
    "s2_title": "Real-world assets are mostly \"dead assets\" on-chain",
    "s2_body": [
      "RWA token holders can mostly only \"hold and collect\" — poor liquidity, single use.",
      "Perpetual traders need stablecoin / blue-chip margin.",
      "Yield assets must be cashed out first to be used as margin —\nwhich means selling, and losing the upside exposure.",
    ],
    "s3_kicker": "INSIGHT -> SOLUTION",
    "s3_title": "Any DEX pair gives you a programmable price",
    "s3_flow": ["Deposit RWA Token", "DEX real-time pricing", "Haircut into margin", "Open perp position"],
    "s4_kicker": "TECH FUSION",
    "s4_title": "Three on-chain finance layers, fused into one system",
    "s4_items": [
      ("ORACLE", "DEX Oracle", "LFJ V1 live quotes via getAmountsOut on-chain pricing"),
      ("ASSET", "RWA Token", "Real-estate rental rights, AccessControl role system"),
      ("SETTLEMENT", "Perp Vault", "Off-chain matching + on-chain net settlement engine"),
    ],
    "s5_kicker": "REAL DEPLOYMENT · NOT STAGED",
    "s5_title": "MultiCollateralVault is really deployed on Fuji testnet",
    "s5_cap": "Verifiable on Snowtrace: contract creation + 3 real on-chain interactions",
    "s6_kicker": "REAL ON-CHAIN TRANSACTIONS",
    "s6_title": "Deposit margin -> signed settlement, fully verifiable",
    "s6_cap_left": "100 RWA tokens really deposited as margin",
    "s6_cap_right": "EIP-712 signed authorization, settled by the operator",
    "s7_kicker": "LIVE DASHBOARD",
    "s7_title": "Nothing here is hardcoded",
    "s7_cap": "Every refresh re-reads Fuji chain state: supply, vault balance, DEX-reserve valuation",
    "s8_kicker": "END-TO-END DEMO",
    "s8_title": "The perpetual trading engine, really running",
    "s8_cap": "Real signed login - real order book depth - real order fills",
    "s9_kicker": "WHY AVALANCHE",
    "s9_title": "Sub-second finality + near-zero gas make this practical",
    "s9_items": [
      "Real transaction fees: around 0.0001 AVAX",
      "DEX prices can be read frequently, cheaply",
      "C-Chain is fully EVM compatible, Solidity reused as-is",
    ],
    "s10_kicker": "AvaVault Perp",
    "s10_title": "Putting sleeping real-world assets back to work",
    "s10_sub": "Thanks for watching - building the next wave of on-chain finance on Avalanche",
  },
}[LANG]

total = 10

# ---- Slide 1: Title ----
img, d = base_canvas()
d.text((120, 380), T["s1_kicker"], font=font(30, True), fill=RED)
f1, size1, lines1 = fit_title(d, T["s1_title"], W - 236, 120, 70)
ty = 430
for ln in lines1:
    d.text((118, ty), ln, font=f1, fill=TEXT)
    ty += int(size1 * 1.15)
sub_y = ty + 20
d.text((122, sub_y), T["s1_sub"], font=font(36), fill=MUTED)
tags_y = sub_y + 80
x = 122
for tag in T["s1_tags"]:
    f = font(24, True)
    tw = d.textlength(tag, font=f)
    d.rounded_rectangle([x, tags_y, x + tw + 40, tags_y + 50], radius=25, fill=CARD, outline=(44, 49, 56))
    d.text((x + 20, tags_y + 13), tag, font=f, fill=GREEN)
    x += tw + 60
draw_footer(d, 1, total)
img.save(f"{OUT_DIR}/01-title.png")

# ---- Slide 2: Problem ----
img, d = base_canvas()
draw_title_bar(d, T["s2_kicker"], T["s2_title"])
y = 280
for line in T["s2_body"]:
    for sub in line.split("\n"):
        d.ellipse([120, y+14, 132, y+26], fill=RED)
        d.text((155, y), sub, font=font(32), fill=TEXT)
        y += 55
    y += 25
draw_footer(d, 2, total)
img.save(f"{OUT_DIR}/02-problem.png")

# ---- Slide 3: Solution flow ----
img, d = base_canvas()
draw_title_bar(d, T["s3_kicker"], T["s3_title"])
items = T["s3_flow"]
n = len(items)
margin = 140
gap = 40
box_w = (W - 2*margin - gap*(n-1)) // n
y0 = 480
for i, label in enumerate(items):
    x0 = margin + i*(box_w+gap)
    d.rounded_rectangle([x0, y0, x0+box_w, y0+160], radius=20, fill=CARD, outline=(44,49,56))
    lines = wrap_text(d, label, font(28, True), box_w-40)
    ly = y0 + 80 - 18*len(lines)
    for ln in lines:
        lw = d.textlength(ln, font=font(28, True))
        d.text((x0 + (box_w-lw)/2, ly), ln, font=font(28, True), fill=TEXT)
        ly += 36
    if i < n-1:
        ax = x0+box_w+8
        d.polygon([(ax, y0+65), (ax+24,y0+80), (ax,y0+95)], fill=RED)
draw_footer(d, 3, total)
img.save(f"{OUT_DIR}/03-solution.png")

# ---- Slide 4: Tech fusion ----
img, d = base_canvas()
draw_title_bar(d, T["s4_kicker"], T["s4_title"])
y = 300
for tag, name, desc in T["s4_items"]:
    d.rounded_rectangle([120, y, 1800, y+170], radius=18, fill=CARD, outline=(44,49,56))
    tag_f = font(24, True)
    tw = d.textlength(tag, font=tag_f)
    pill_w = max(150, int(tw) + 48)
    d.rounded_rectangle([150, y+30, 150+pill_w, y+30+50], radius=25, fill=RED)
    d.text((150+(pill_w-tw)/2, y+43), tag, font=tag_f, fill=(255,255,255))
    name_x = max(340, 150 + pill_w + 30)
    d.text((name_x, y+25), name, font=font(38, True), fill=TEXT)
    for j, dl in enumerate(wrap_text(d, desc, font(26), W - 120 - name_x)):
        d.text((name_x, y+85+j*34), dl, font=font(26), fill=MUTED)
    y += 200
draw_footer(d, 4, total)
img.save(f"{OUT_DIR}/04-fusion.png")

# ---- Slide 5: Screenshot - vault contract ----
img, d = base_canvas()
draw_title_bar(d, T["s5_kicker"], T["s5_title"])
paste_screenshot(img, f"{SCREEN_DIR}/02-vault-contract-snowtrace.png", (260, 260, 1660, 900))
d = ImageDraw.Draw(img)
cap = T["s5_cap"]
cw = d.textlength(cap, font=font(28))
d.text(((W-cw)/2, 930), cap, font=font(28), fill=MUTED)
draw_footer(d, 5, total)
img.save(f"{OUT_DIR}/05-deploy-proof.png")

# ---- Slide 6: Two real tx screenshots side by side ----
img, d = base_canvas()
draw_title_bar(d, T["s6_kicker"], T["s6_title"])
paste_screenshot(img, f"{SCREEN_DIR}/03-real-deposit-tx-snowtrace.png", (120, 260, 940, 860))
paste_screenshot(img, f"{SCREEN_DIR}/04-real-settle-tx-snowtrace.png", (980, 260, 1800, 860))
d = ImageDraw.Draw(img)
d.text((120, 880), T["s6_cap_left"], font=font(24), fill=MUTED)
d.text((980, 880), T["s6_cap_right"], font=font(24), fill=MUTED)
draw_footer(d, 6, total)
img.save(f"{OUT_DIR}/06-real-txs.png")

# ---- Slide 7: Dashboard screenshot ----
img, d = base_canvas()
draw_title_bar(d, T["s7_kicker"], T["s7_title"])
paste_screenshot(img, f"{SCREEN_DIR}/05-onchain-dashboard.png", (260, 260, 1660, 900))
d = ImageDraw.Draw(img)
cap = T["s7_cap"]
cw = d.textlength(cap, font=font(26))
d.text(((W-cw)/2, 930), cap, font=font(26), fill=MUTED)
draw_footer(d, 7, total)
img.save(f"{OUT_DIR}/07-dashboard.png")

# ---- Slide 8: Perp dex demo screenshot ----
img, d = base_canvas()
draw_title_bar(d, T["s8_kicker"], T["s8_title"])
paste_screenshot(img, f"{SCREEN_DIR}/01-perp-dex-orderbook.png", (310, 240, 1610, 900))
d = ImageDraw.Draw(img)
cap = T["s8_cap"]
cw = d.textlength(cap, font=font(26))
d.text(((W-cw)/2, 930), cap, font=font(26), fill=MUTED)
draw_footer(d, 8, total)
img.save(f"{OUT_DIR}/08-trading-demo.png")

# ---- Slide 9: Why Avalanche ----
img, d = base_canvas()
draw_title_bar(d, T["s9_kicker"], T["s9_title"])
y = 320
for item in T["s9_items"]:
    d.ellipse([120, y+14, 132, y+26], fill=GREEN)
    d.text((155, y), item, font=font(32), fill=TEXT)
    y += 80
draw_footer(d, 9, total)
img.save(f"{OUT_DIR}/09-why-avalanche.png")

# ---- Slide 10: Closing ----
img, d = base_canvas()
d.text((120, 420), T["s10_kicker"], font=font(30, True), fill=RED)
f10, size10, lines10 = fit_title(d, T["s10_title"], W - 236, 90, 50)
ty10 = 470
for ln in lines10:
    d.text((118, ty10), ln, font=f10, fill=TEXT)
    ty10 += int(size10 * 1.15)
sub_y10 = ty10 + 30
for j, ln in enumerate(wrap_text(d, T["s10_sub"], font(34), W - 320)):
    d.text((122, sub_y10 + j*46), ln, font=font(34), fill=MUTED)
draw_footer(d, 10, total)
img.save(f"{OUT_DIR}/10-closing.png")

print("done", LANG, "->", OUT_DIR)
