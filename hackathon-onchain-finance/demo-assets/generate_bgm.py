#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 numpy 合成一段原创的、安静、节奏适中的科技/金融风格纯音乐底噪(背景音乐)，
避免使用任何有版权风险的素材。

结构：
  - 4 个和弦循环 (Am9 - Fmaj7 - Cmaj7 - G6)，每个和弦 2 小节，BPM=86
  - pad 层：柔和正弦+少量二次谐波，慢起慢落包络，负责"底色"
  - 分解和弦层 (arpeggio)：八分音符琶音，短促衰减，负责"节奏感"，但音量克制
  - sub bass 层：根音低八度正弦，很轻，增加厚度但不抢戏

输出 44.1kHz / 16-bit 单声道(自动在合成时双声道) WAV。

用法:
    python3 generate_bgm.py <输出路径> <目标时长秒数>
"""
import sys
import numpy as np
import wave
import struct

SR = 44100
BPM = 86
BEAT = 60.0 / BPM

NOTE_FREQS = {
    "A2": 110.00, "C3": 130.81, "D3": 146.83, "E3": 164.81, "F3": 174.61, "G3": 196.00,
    "A3": 220.00, "B3": 246.94, "C4": 261.63, "D4": 293.66, "E4": 329.63, "F4": 349.23,
    "G4": 392.00, "A4": 440.00, "B4": 493.88, "C5": 523.25, "E5": 659.25, "G5": 783.99,
}

# 和弦进行：根音(用于 bass) + 琶音音符序列 (上行再回落，听起来柔和不生硬)
PROGRESSION = [
    {"bass": "A2", "arp": ["A3", "C4", "E4", "G4", "E4", "C4"]},   # Am9
    {"bass": "F3", "arp": ["F3", "A3", "C4", "E4", "C4", "A3"]},   # Fmaj7
    {"bass": "C3", "arp": ["C4", "E4", "G4", "B4", "G4", "E4"]},   # Cmaj7
    {"bass": "G3", "arp": ["G3", "B3", "D4", "E4", "D4", "B3"]},   # G6
]

BARS_PER_CHORD = 2
BEATS_PER_BAR = 4


def env_adsr(n, sr, attack, release):
    """简单的 attack/release 包络（线性淡入淡出），避免咔哒声。"""
    env = np.ones(n)
    a = int(attack * sr)
    r = int(release * sr)
    a = min(a, n // 2)
    r = min(r, n // 2)
    if a > 0:
        env[:a] = np.linspace(0, 1, a)
    if r > 0:
        env[-r:] = np.linspace(1, 0, r)
    return env


def pluck_env(n, sr, decay=0.35):
    t = np.arange(n) / sr
    return np.exp(-t / decay)


def synth_pad(freq, dur, sr):
    t = np.arange(int(dur * sr)) / sr
    sig = 0.7 * np.sin(2 * np.pi * freq * t) + 0.2 * np.sin(2 * np.pi * freq * 2 * t)
    sig *= env_adsr(len(sig), sr, attack=min(0.8, dur * 0.3), release=min(0.8, dur * 0.3))
    return sig


def synth_pluck(freq, dur, sr):
    t = np.arange(int(dur * sr)) / sr
    sig = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * freq * 2 * t)
    sig *= pluck_env(len(sig), sr, decay=dur * 0.9)
    return sig


def synth_bass(freq, dur, sr):
    t = np.arange(int(dur * sr)) / sr
    sig = np.sin(2 * np.pi * (freq / 2) * t)
    sig *= env_adsr(len(sig), sr, attack=0.05, release=min(0.6, dur * 0.3))
    return sig


def lowpass(signal, sr, cutoff):
    """一阶巴特沃斯低通，去掉刺耳高频，让音色更柔和（用 scipy 矢量化，避免逐样本 Python 循环太慢）。"""
    from scipy.signal import butter, lfilter
    b, a = butter(2, cutoff / (sr / 2), btype="low")
    return lfilter(b, a, signal)



def build_loop_seconds(n_loops):
    chord_dur = BARS_PER_CHORD * BEATS_PER_BAR * BEAT
    loop_dur = chord_dur * len(PROGRESSION)
    total_dur = loop_dur * n_loops
    n_samples = int(total_dur * SR)
    out = np.zeros(n_samples)

    t_cursor = 0.0
    for _ in range(n_loops):
        for chord in PROGRESSION:
            start_idx = int(t_cursor * SR)
            # pad：整段和弦时值
            pad = synth_pad(NOTE_FREQS[chord["arp"][0]] / 2, chord_dur, SR) * 0.10
            pad += synth_pad(NOTE_FREQS[chord["arp"][2]] / 2, chord_dur, SR) * 0.08
            end_idx = start_idx + len(pad)
            if end_idx <= n_samples:
                out[start_idx:end_idx] += pad

            # sub bass：整段和弦时值，很轻
            bass = synth_bass(NOTE_FREQS[chord["bass"]], chord_dur, SR) * 0.09
            end_idx = start_idx + len(bass)
            if end_idx <= n_samples:
                out[start_idx:end_idx] += bass

            # 琶音：八分音符
            note_dur = BEAT / 2
            n_notes = int(round(chord_dur / note_dur))
            arp_notes = chord["arp"]
            for i in range(n_notes):
                note = arp_notes[i % len(arp_notes)]
                pluck = synth_pluck(NOTE_FREQS[note], note_dur * 1.6, SR) * 0.075
                s_idx = int((t_cursor + i * note_dur) * SR)
                e_idx = s_idx + len(pluck)
                if e_idx <= n_samples:
                    out[s_idx:e_idx] += pluck
                elif s_idx < n_samples:
                    out[s_idx:n_samples] += pluck[: n_samples - s_idx]

            t_cursor += chord_dur

    out = lowpass(out, SR, cutoff=3800)
    # 归一化到比较保守的电平（后面混音时还会进一步 duck + 降低音量）
    peak = np.max(np.abs(out)) + 1e-9
    out = out / peak * 0.85
    return out


def write_wav(path, mono_signal, sr):
    stereo = np.stack([mono_signal, mono_signal], axis=1)
    pcm = np.clip(stereo * 32767, -32768, 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def main():
    out_path = sys.argv[1]
    target_dur = float(sys.argv[2])
    chord_dur = BARS_PER_CHORD * BEATS_PER_BAR * BEAT
    loop_dur = chord_dur * len(PROGRESSION)
    n_loops = int(np.ceil(target_dur / loop_dur)) + 1
    sig = build_loop_seconds(n_loops)
    need_samples = int(target_dur * SR)
    if len(sig) < need_samples:
        sig = np.pad(sig, (0, need_samples - len(sig)))
    sig = sig[:need_samples]
    write_wav(out_path, sig, SR)
    print(f"wrote {out_path}: {target_dur:.2f}s @ {SR}Hz, bpm={BPM}")


if __name__ == "__main__":
    main()
