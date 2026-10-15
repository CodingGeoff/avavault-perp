#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# 后期合成：原始录屏 + 英文配音 + 片头片尾 + 烧入英文字幕
#
# 时间线：片头(5s) + 主体 + 片尾(6s)；主体按场景切分，只有 deposit_rwa 段
# 轻微降速（1.228x）以容纳该段旁白，其余场景保持 1.0x。
# 输出：/home/user/avavault-perp-video/avavault-perp-demo-en.mp4
# ---------------------------------------------------------------------------
import json, os, subprocess, sys

ROOT = "/home/user/demo_video"
RAW = os.path.join(ROOT, "raw")
VOICE = os.path.join(ROOT, "voice")
WORK = os.path.join(ROOT, "work")
OUTDIR = "/home/user/avavault-perp-video"
VIDEO = "avavault-perp-demo-en.mp4"
os.makedirs(WORK, exist_ok=True); os.makedirs(OUTDIR, exist_ok=True)

TITLE_DUR, OUTRO_DUR, LEAD = 5.0, 6.0, 0.35
W, H, FPS = 1920, 1080, 25
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
# 只对这一段做时间拉伸
STRETCH = {"deposit_rwa": 1.228}


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("CMD FAILED:", " ".join(cmd[:10]), file=sys.stderr); print(r.stderr[-2500:], file=sys.stderr)
        raise SystemExit(1)
    return r


def dur(p):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).stdout.strip())


scenes = json.load(open(os.path.join(RAW, "scenes.json")))
chunks = json.load(open(os.path.join(ROOT, "narration.json")))["chunks"]
narration = {c["id"]: c for c in chunks}
raw_video = max(scenes["video"], key=dur)
print(f"[i] 原始录屏 {os.path.basename(raw_video)} ({dur(raw_video):.1f}s)  结算 tx {scenes.get('txHash')}")

seg = scenes["scenes"]                       # 场景列表（实测边界）
SEG_LEN = {s["name"]: s["dur"] for s in seg}

# ---------------------------------------------------------------- 1) 逐场景切分/按需拉伸
parts, t_cursor = [], 0.0
for s in seg:
    name, start, end = s["name"], s["start"], s["end"]
    factor = STRETCH.get(name, 1.0)
    out = os.path.join(WORK, f"part_{name}.mp4")
    vf = f"setpts={factor}*PTS" if factor != 1.0 else "null"
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", raw_video,
         "-vf", f"{vf},scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps={FPS}",
         "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", out])
    real = dur(out)
    s["adj_start"] = t_cursor
    s["adj_end"] = t_cursor + real
    t_cursor += real
    parts.append(out)
    print(f"    {name:<14} {start:7.2f}→{end:7.2f}  x{factor:<5}  成片 {real:6.2f}s  时间轴 {s['adj_start']:7.2f}→{s['adj_end']:6.2f}")
main_dur = t_cursor
adj = {s["name"]: s["adj_start"] for s in seg}

# ---------------------------------------------------------------- 2) 片头 / 片尾
def card(path, lines, secs):
    """用 textfile= 传入文案，避免冒号/逗号等字符破坏 filter 语法"""
    y0 = H // 2 - (len(lines) * 78) // 2
    draw = []
    for i, (t, z, c, f) in enumerate(lines):
        tf = os.path.join(WORK, f"txt_{os.path.basename(path)}_{i}.txt")
        open(tf, "w", encoding="utf-8").write(t)
        draw.append(f"drawtext=fontfile={f}:textfile={tf}:fontcolor={c}:fontsize={z}:"
                    f"x=(w-text_w)/2:y={y0 + i * 78}")
    draw.append(f"fade=t=in:st=0:d=0.6,fade=t=out:st={secs - 0.6}:d=0.6")
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x0f1114:s={W}x{H}:d={secs}:r={FPS}",
         "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
         "-vf", ",".join(draw), "-t", str(secs), "-c:v", "libx264", "-preset", "medium", "-crf", "20",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", path])


title = os.path.join(WORK, "title.mp4")
card(title, [("AvaVault Perp", 88, "0xE84142", FONT),
             ("Live demo — perpetual margin on tokenized real-world assets", 34, "0xFFFFFF", FONT_R),
             ("Avalanche Fuji testnet  ·  real wallet, real transactions, real settlement", 28, "0x9AA4AF", FONT_R)], TITLE_DUR)
outro = os.path.join(WORK, "outro.mp4")
card(outro, [("Every transaction in this demo is real", 54, "0xFFFFFF", FONT),
             ("Verified on Avalanche Fuji testnet — Snowtrace", 32, "0x9AA4AF", FONT_R),
             ("PerpMarginAccount 0xB329…1610  ·  SimpleMarkOracle 0x713E…C482", 28, "0xE84142", FONT_R),
             ("github.com/CodingGeoff/avavault-perp", 30, "0x9AA4AF", FONT_R)], OUTRO_DUR)

# ---------------------------------------------------------------- 3) 拼接主体
main_mp4 = os.path.join(WORK, "main.mp4")
lst = os.path.join(WORK, "main_list.txt")
open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
     "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-an", main_mp4])
print(f"[i] 主体拼接 {dur(main_mp4):.2f}s（拉伸后，原 {seg[-1]['end']:.2f}s）")

full = os.path.join(WORK, "full_silent.mp4")
lst2 = os.path.join(WORK, "full_list.txt")
open(lst2, "w").write("".join(f"file '{p}'\n" for p in (title, main_mp4, outro)))
run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst2,
     "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "192k", full])
full_dur = dur(full)
print(f"[i] 全片（无旁白）{full_dur:.2f}s = 片头 {TITLE_DUR} + 主体 {main_dur:.2f} + 片尾 {OUTRO_DUR}")

# ---------------------------------------------------------------- 4) 旁白音轨（按调整后的场景起点）
scene_of_chunk = {"c1": "ready", "c2": "book", "c3": "connect", "c4": "deposit_usdc",
                  "c5": "deposit_rwa", "c6": "hedge", "c7": "order_settle", "c8": "position",
                  "c9": "snowtrace"}
offsets = {cid: TITLE_DUR + adj[sc] + LEAD for cid, sc in scene_of_chunk.items()}
inputs, filters, labels = [], [], []
for i, cid in enumerate(sorted(offsets)):
    inputs += ["-i", os.path.join(VOICE, f"{cid}.mp3")]
    ms = int(offsets[cid] * 1000)
    filters.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}[a{i}]")
    labels.append(f"[a{i}]")
filters.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0:duration=longest[aout]")
narr = os.path.join(WORK, "narration.m4a")
run(["ffmpeg", "-y", "-v", "error"] + inputs + ["-filter_complex", ";".join(filters), "-map", "[aout]",
                                                 "-t", str(full_dur), "-c:a", "aac", "-b:a", "192k", narr])
last_end = max(offsets[c] + dur(os.path.join(VOICE, f"{c}.mp3")) for c in offsets)
print(f"[i] 旁白音轨 {dur(narr):.2f}s，最后一句结束于 {last_end:.2f}s")

# ---------------------------------------------------------------- 5) 字幕（与配音逐段对齐）
def wrap(text, width=66):
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 <= width:
            cur = f"{cur} {w}".strip()
        else:
            lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines


def ts(t):
    h, r = divmod(max(t, 0), 3600); m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}".replace(".", ",")


srt, idx = [], 0
for cid in sorted(offsets):
    lines = wrap(narration[cid]["text"])
    start, total = offsets[cid], dur(os.path.join(VOICE, f"{cid}.mp3"))
    per = total / len(lines)
    for i, line in enumerate(lines):
        idx += 1
        s, e = start + i * per, start + i * per + per * 0.94
        srt.append(f"{idx}\n{ts(s)} --> {ts(e)}\n{line}\n")
srt_path = os.path.join(WORK, "subs.srt")
open(srt_path, "w", encoding="utf-8").write("\n".join(srt))
print(f"[i] 字幕 {idx} 条")

# ---------------------------------------------------------------- 6) 烧字幕 + 合音轨
style = ("FontName=DejaVu Sans,FontSize=21,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
         "BorderStyle=1,Outline=2,Shadow=1,MarginV=34,Alignment=2")
final = os.path.join(OUTDIR, VIDEO)
run(["ffmpeg", "-y", "-v", "error", "-i", full, "-i", narr, "-vf", f"subtitles={srt_path}:force_style='{style}'",
     "-map", "0:v", "-map", "1:a", "-shortest", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
     "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1", "-movflags", "+faststart",
     "-c:a", "aac", "-b:a", "192k", final])
print(f"[✓] 成片 {final}  {dur(final):.2f}s  {os.path.getsize(final)/1e6:.1f} MB")
