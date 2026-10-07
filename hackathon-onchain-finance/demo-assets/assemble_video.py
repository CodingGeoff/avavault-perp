#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 slides_<lang>/*.png + audio_<lang>/sceneN.mp3 按 narration_<lang>.json 里的场景顺序
拼成一个 mp4。每个场景的音频时长，按场景里图片数量平均分配给每张图片的展示时长。

用法:
    python3 assemble_video.py zh
    python3 assemble_video.py en

依赖: ffmpeg / ffprobe 在 PATH 里（Windows 装 ffmpeg 官方版即可，Mac 用
`brew install ffmpeg`，Linux 用 `apt install ffmpeg`）。
"""
import json
import subprocess
import sys
import os

LANG = sys.argv[1] if len(sys.argv) > 1 else "zh"
HERE = os.path.dirname(os.path.abspath(__file__))

NARRATION = os.path.join(HERE, f"narration_{LANG}.json")
SLIDES_DIR = os.path.join(HERE, f"slides_{LANG}")
AUDIO_DIR = os.path.join(HERE, f"audio_{LANG}")
OUT = os.path.join(HERE, f"avavault-perp-pitch-{LANG}.mp4")


def ffprobe_duration(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path
    ])
    return float(out.strip())


def main():
    with open(NARRATION, "r", encoding="utf-8") as f:
        scenes = json.load(f)

    # 1) 拼接全部场景音频成一条完整音轨
    concat_audio_list = os.path.join(HERE, f"_audio_concat_{LANG}.txt")
    with open(concat_audio_list, "w") as f:
        for sc in scenes:
            apath = os.path.join(AUDIO_DIR, f"scene{sc['scene']}.mp3")
            f.write(f"file '{apath}'\n")
    full_audio = os.path.join(HERE, f"_full_audio_{LANG}.mp3")
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_audio_list,
        "-c", "copy", full_audio
    ], check=True)

    # 2) 为每张图片计算展示时长（场景音频时长 / 场景内图片数）
    concat_img_list = os.path.join(HERE, f"_images_concat_{LANG}.txt")
    with open(concat_img_list, "w") as f:
        for sc in scenes:
            apath = os.path.join(AUDIO_DIR, f"scene{sc['scene']}.mp3")
            dur = ffprobe_duration(apath)
            per_slide = dur / len(sc["slides"])
            for slide in sc["slides"]:
                ipath = os.path.join(SLIDES_DIR, slide)
                f.write(f"file '{ipath}'\n")
                f.write(f"duration {per_slide:.3f}\n")
        # ffmpeg concat demuxer 要求最后一张图再重复一行（没有 duration 的收尾行）才会生效
        last_slide = scenes[-1]["slides"][-1]
        f.write(f"file '{os.path.join(SLIDES_DIR, last_slide)}'\n")

    video_noaudio = os.path.join(HERE, f"_video_noaudio_{LANG}.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_img_list,
        "-vsync", "vfr", "-pix_fmt", "yuv420p",
        "-vf", "scale=1920:1080",
        video_noaudio
    ], check=True)

    # 3) 合并视频 + 完整音轨
    subprocess.run([
        "ffmpeg", "-y", "-i", video_noaudio, "-i", full_audio,
        "-c:v", "libx264", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-b:a", "160k",
        "-shortest", OUT
    ], check=True)

    for tmp in [concat_audio_list, concat_img_list, full_audio, video_noaudio]:
        os.remove(tmp)

    print("DONE ->", OUT)


if __name__ == "__main__":
    main()
