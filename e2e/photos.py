# -*- coding: utf-8 -*-
"""測試即時產生的虛構貨單照片（不讀 spike 任何檔案）。
PNG 用 zlib 手寫，再用 macOS sips 轉成 JPEG。每張照片的 (寬,高) 就是「這張貨單的身分證」：
假 Ollama 讀 JPEG 檔頭的尺寸就知道要回哪一份辨識資料（sips -Z 1600 不會放大，尺寸不變）。"""
import os
import random
import struct
import subprocess
import zlib


def _png(w, h, rng):
    bg = (250, 248, 240)
    head = (rng.randrange(30, 200), rng.randrange(30, 200), rng.randrange(30, 200))
    rows = []
    for y in range(h):
        row = bytearray()
        if y < 40:
            px = [head] * w
        else:
            line = (y // 18) % 2 == 0 and 60 < y < h - 40
            px = []
            for x in range(w):
                if line and 20 < x < w - 20 and (x // 6 + y // 18) % 3 != 0:
                    px.append((40, 40, 40))
                else:
                    px.append(bg)
        for p in px:
            row += bytes(p)
        rows.append(b'\x00' + bytes(row))
    raw = b''.join(rows)

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def make_jpeg(path_dir, w, h, seed):
    rng = random.Random(seed)
    png = os.path.join(path_dir, f'p{w}x{h}.png')
    jpg = os.path.join(path_dir, f'p{w}x{h}.jpg')
    if not os.path.exists(jpg):
        with open(png, 'wb') as f:
            f.write(_png(w, h, rng))
        subprocess.run(['sips', '-s', 'format', 'jpeg', png, '--out', jpg], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.remove(png)
    return jpg


def jpeg_dims(data):
    """讀 JPEG SOF 區段 → (寬, 高)。"""
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        m = data[i + 1]
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        ln = struct.unpack('>H', data[i + 2:i + 4])[0]
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack('>HH', data[i + 5:i + 9])
            return w, h
        i += 2 + ln
    return None
