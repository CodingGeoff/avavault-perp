# Demo 素材

这个文件夹是 AvaVault Perp 的演示素材：Demo 视频（中/英文各一版）、配套的 Pitch Deck，
以及制作过程中用到的原始截图和脚本。

## 成品

| 文件 | 内容 |
| --- | --- |
| `avavault-perp-pitch-zh.mp4` | 中文版 Demo 视频，约 2 分 26 秒 |
| `avavault-perp-pitch-en.mp4` | 英文版 Demo 视频，约 1 分 51 秒 |
| `avavault-perp-pitch-zh.pptx` / `-en.pptx` | 对应的 Pitch Deck 源文件（10 页，可编辑） |
| `raw_screenshots/` | 交易界面截图 + 链上浏览器（Snowtrace）截图 + 自建的链上数据仪表盘截图 |

截图涵盖：永续合约交易界面的实际运行效果、Fuji 测试网上已部署合约与真实交易在 Snowtrace
上的记录、以及一个直连 Fuji RPC 节点实时展示合约状态的仪表盘页面。

## 文件夹结构

```
demo-assets/
├── raw_screenshots/           # 截图素材，想替换某一张可以直接换同名 PNG
├── slides_zh/ slides_en/      # 拼好的幻灯片图片（1920x1080）
├── audio_zh/ audio_en/        # 分场景的配音音频
├── narration_zh.json          # 中文文案及其对应的幻灯片
├── narration_en.json          # 英文文案及其对应的幻灯片
├── build_slides.py            # 文案 + 截图 -> 幻灯片图片
├── build_pptx.py              # 同一份内容 -> 可编辑的 .pptx
├── assemble_video.py          # 幻灯片 + 配音 -> 最终 mp4
├── fetch_dashboard_data.mjs   # 读取链上数据，用于生成仪表盘截图
├── render_dashboard.html      # 仪表盘页面
├── capture_dashboard.mjs      # 仪表盘页面截图脚本
├── capture_public_pages.mjs   # Snowtrace 页面截图脚本
└── dashboard_data.json        # 一次链上数据快照
```

## 如何在本地修改和重新生成

需要 Python 3.9+ 和 ffmpeg：

```bash
pip install python-pptx pillow
# macOS: brew install ffmpeg
# Ubuntu/Debian: sudo apt install ffmpeg
# Windows: 参考仓库根目录 WINDOWS_CHINA_DEV_GUIDE.md
```

**改文案**：编辑 `build_slides.py` 顶部的 `T = {...}` 字典，然后 `python3 build_slides.py zh`
（或 `en`）重新生成幻灯片图片。

**换配音**：修改 `narration_zh.json` / `narration_en.json` 里对应 scene 的文字，用你习惯的
方式重新生成同名的 `audio_zh/sceneN.mp3`（保持文件名不变）。

**换截图**：把新图片放进 `raw_screenshots/`，保持文件名一致，或者在 `build_slides.py` 里改
对应的文件名引用。

**重新渲染视频**：

```bash
python3 assemble_video.py zh
python3 assemble_video.py en
```

**重新生成可编辑 PPT**：

```bash
python3 build_pptx.py zh
python3 build_pptx.py en
```

PPT 中的标题和正文都是可编辑文本框，截图是可替换的图片对象。
