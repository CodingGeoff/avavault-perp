#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给已经做好的 avavault-perp-pitch-<lang>.mp4（视频 + 旁白/结算音效，已经验证过时长和
画面拼接都正确）叠加一轨很轻的原创背景音乐：
  - 背景音乐先整体降低音量（很安静）
  - 再用 sidechaincompress 让它跟着旁白自动"闪避"（有人声时几乎听不见，
    没人声的空隙时略微浮起来一点点），这样听感上既不会盖过旁白，也不会死气沉沉。
  - 只替换音轨，视频流原封不动 (-c:v copy)，不会影响任何已经验证过的画面/时长。

用法:
    python3 add_bgm.py zh
    python3 add_bgm.py en
"""
import subprocess
import sys
import os

LANG = sys.argv[1] if len(sys.argv) > 1 else "zh"
HERE = os.path.dirname(os.path.abspath(__file__))

VIDEO_IN = os.path.join(HERE, f"avavault-perp-pitch-{LANG}.mp4")
BGM = os.path.join(HERE, f"bgm_{LANG}.wav")
OUT = os.path.join(HERE, f"avavault-perp-pitch-{LANG}-withbgm.mp4")

# 背景音乐基础音量：在原本已经比较柔和的合成音轨基础上再压低，
# 让它处于"很安静、隐约能感觉到"的程度，而不是能和旁白抢注意力的程度。
MUSIC_BASE_VOLUME = 0.17


def run(cmd):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main():
    filter_complex = (
        f"[0:a]asplit=2[voice_main][voice_sc];"
        f"[1:a]volume={MUSIC_BASE_VOLUME}[music_pre];"
        f"[music_pre][voice_sc]sidechaincompress="
        f"threshold=0.02:ratio=12:attack=25:release=400:makeup=1[music_duck];"
        f"[voice_main][music_duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed];"
        f"[mixed]alimiter=limit=0.95[aout]"
    )
    run([
        "ffmpeg", "-y",
        "-i", VIDEO_IN,
        "-i", BGM,
        "-filter_complex", filter_complex,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        OUT,
    ])
    print("DONE ->", OUT)


if __name__ == "__main__":
    main()
