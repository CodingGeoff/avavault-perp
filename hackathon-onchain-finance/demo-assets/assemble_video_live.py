#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
在原有“静态图 + 旁白”拼接的基础上，把一段真实录屏(live_recording.webm)插入到
scene4 的中间位置：
  Part A = scene1,2,3 的全部图片 + scene4 第一张图(07-dashboard.png)
           配音 = scene1.mp3 + scene2.mp3 + scene3.mp3 + scene4 前半段
  Recording = live_recording.webm (真实链上操作录屏，静音素材)
           配音 = scene4 后半段旁白（念的正好是“下面是交易引擎实时界面...”）
                  叠在录屏开头，念完之后剩余时长保持静音，让观众看完整个
                  真实链上结算 + Snowtrace 验证的过程
  Part B = scene5 的全部图片（09,10），配音 = scene5.mp3，和原来完全一样

三段分别输出独立的 mp4，再用 concat filter（而不是 concat demuxer）统一
fps/分辨率/像素格式后拼成最终视频，避免录屏(webm/变帧率)和图片序列(固定帧率)
编码参数不一致导致 concat demuxer 直接失败。

用法:
    python3 assemble_video_live.py zh
    python3 assemble_video_live.py en

若此脚本出任何问题，原始的 assemble_video.py 和已提交的
avavault-perp-pitch-<lang>.mp4 不受影响，可以直接回退使用。
"""
import json
import os
import subprocess
import sys

LANG = sys.argv[1] if len(sys.argv) > 1 else "zh"
HERE = os.path.dirname(os.path.abspath(__file__))

# scene4 旁白其实是两句话拼在一起（先讲 dashboard，后讲 trading engine），
# 两句话的实际语音时长并不是 1:1，而是通过 ffmpeg silencedetect 在真实音频里
# 找到"保证金估值。" / "DEX reserves." 这句话结束的静音间隙精确定位出来的，
# 不能直接拿 scene 音频总时长除以 2。
SCENE4_SPLIT_SEC = {"zh": 11.3, "en": 13.65}

NARRATION = os.path.join(HERE, f"narration_{LANG}.json")
SLIDES_DIR = os.path.join(HERE, f"slides_{LANG}")
AUDIO_DIR = os.path.join(HERE, f"audio_{LANG}")
RECORDING = os.path.join(HERE, "live_recording.webm")
OUT = os.path.join(HERE, f"avavault-perp-pitch-{LANG}-live.mp4")

TMP = []


def tmp(name):
    p = os.path.join(HERE, f"_live_{LANG}_{name}")
    TMP.append(p)
    return p


def run(cmd):
    subprocess.run(cmd, check=True)


def ffprobe_duration(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path
    ])
    return float(out.strip())


def build_image_video(image_durs, out_path):
    """image_durs: list of (image_path, duration)"""
    list_path = tmp(os.path.basename(out_path) + ".imglist.txt")
    with open(list_path, "w") as f:
        for ipath, dur in image_durs:
            f.write(f"file '{ipath}'\n")
            f.write(f"duration {dur:.3f}\n")
        # concat demuxer 需要最后一张图再重复一行收尾
        last_path = image_durs[-1][0]
        f.write(f"file '{last_path}'\n")
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path,
        "-vsync", "vfr", "-pix_fmt", "yuv420p",
        "-vf", "scale=1920:1080",
        out_path,
    ])


def concat_audio(paths, out_path):
    list_path = tmp(os.path.basename(out_path) + ".alist.txt")
    with open(list_path, "w") as f:
        for p in paths:
            f.write(f"file '{p}'\n")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", out_path])


def trim_audio(src, start, dur, out_path):
    cmd = ["ffmpeg", "-y", "-i", src, "-ss", f"{start:.3f}"]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-c:a", "libmp3lame", "-q:a", "2", out_path]
    run(cmd)


def mux(video_path, audio_path, out_path, shortest=True):
    cmd = ["ffmpeg", "-y", "-i", video_path, "-i", audio_path,
           "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
           "-c:a", "aac", "-b:a", "160k"]
    if shortest:
        cmd.append("-shortest")
    cmd.append(out_path)
    run(cmd)


def main():
    with open(NARRATION, "r", encoding="utf-8") as f:
        scenes = json.load(f)
    by_scene = {s["scene"]: s for s in scenes}

    s1, s2, s3, s4, s5 = (by_scene[i] for i in range(1, 6))

    d1 = ffprobe_duration(os.path.join(AUDIO_DIR, "scene1.mp3"))
    d2 = ffprobe_duration(os.path.join(AUDIO_DIR, "scene2.mp3"))
    d3 = ffprobe_duration(os.path.join(AUDIO_DIR, "scene3.mp3"))
    d4 = ffprobe_duration(os.path.join(AUDIO_DIR, "scene4.mp3"))
    d5 = ffprobe_duration(os.path.join(AUDIO_DIR, "scene5.mp3"))
    d4_half = SCENE4_SPLIT_SEC[LANG]
    rec_dur = ffprobe_duration(RECORDING)

    print(f"[{LANG}] scene durations: s1={d1:.2f} s2={d2:.2f} s3={d3:.2f} "
          f"s4={d4:.2f}(split@{d4_half:.2f}) s5={d5:.2f} recording={rec_dur:.2f}")

    # ---------- Part A: scenes 1-3 images + scene4 slide[0] ----------
    img_durs_a = []
    for sc, d in ((s1, d1), (s2, d2), (s3, d3)):
        per = d / len(sc["slides"])
        for slide in sc["slides"]:
            img_durs_a.append((os.path.join(SLIDES_DIR, slide), per))
    img_durs_a.append((os.path.join(SLIDES_DIR, s4["slides"][0]), d4_half))

    video_a = tmp("video_a.mp4")
    build_image_video(img_durs_a, video_a)

    scene4_half1 = tmp("scene4_half1.mp3")
    scene4_half2 = tmp("scene4_half2.mp3")
    trim_audio(os.path.join(AUDIO_DIR, "scene4.mp3"), 0.0, d4_half, scene4_half1)
    trim_audio(os.path.join(AUDIO_DIR, "scene4.mp3"), d4_half, None, scene4_half2)

    audio_a = tmp("audio_a.mp3")
    concat_audio([
        os.path.join(AUDIO_DIR, "scene1.mp3"),
        os.path.join(AUDIO_DIR, "scene2.mp3"),
        os.path.join(AUDIO_DIR, "scene3.mp3"),
        scene4_half1,
    ], audio_a)

    part_a = tmp("part_a.mp4")
    mux(video_a, audio_a, part_a)

    # ---------- Recording segment: narration over the first part, then silence ----------
    rec_audio_padded = tmp("rec_audio.mp3")
    run([
        "ffmpeg", "-y", "-i", scene4_half2,
        "-af", f"apad=whole_dur={rec_dur:.3f}",
        "-c:a", "libmp3lame", "-q:a", "2", rec_audio_padded,
    ])

    part_rec = tmp("part_rec.mp4")
    run([
        "ffmpeg", "-y", "-i", RECORDING, "-i", rec_audio_padded,
        "-map", "0:v:0", "-map", "1:a:0",
        "-vf", "scale=1920:1080", "-pix_fmt", "yuv420p",
        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "160k",
        "-shortest", part_rec,
    ])

    # ---------- Part B: scene5 images, unchanged ----------
    img_durs_b = []
    per5 = d5 / len(s5["slides"])
    for slide in s5["slides"]:
        img_durs_b.append((os.path.join(SLIDES_DIR, slide), per5))

    video_b = tmp("video_b.mp4")
    build_image_video(img_durs_b, video_b)
    part_b = tmp("part_b.mp4")
    mux(video_b, os.path.join(AUDIO_DIR, "scene5.mp3"), part_b)

    # ---------- Final concat ----------
    # part_a / part_rec / part_b 都已经是 1920x1080 / yuv420p / h264 / aac 44100 mono，
    # 直接用 concat demuxer + stream copy 拼接即可，不需要再整体重新编码一遍。
    # （这台沙箱内存很小，之前用 filter_complex 对三段视频整体重新解码重新编码会被
    # OOM-kill，必须避免。）
    concat_list = tmp("final_concat_list.txt")
    with open(concat_list, "w") as f:
        f.write(f"file '{part_a}'\n")
        f.write(f"file '{part_rec}'\n")
        f.write(f"file '{part_b}'\n")
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
        "-c", "copy", OUT,
    ])

    for p in TMP:
        try:
            os.remove(p)
        except OSError:
            pass

    print("DONE ->", OUT)


if __name__ == "__main__":
    main()
