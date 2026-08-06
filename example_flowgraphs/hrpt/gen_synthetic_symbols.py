#!/usr/bin/env python3
"""Generate synthetic NOAA HRPT minor frames (biphase-encoded bit stream)
carrying real test imagery on AVHRR channel 2, verified by replaying gr-hrpt's
own noaa_hrpt_deframer_impl.cc state machine in Python.

Run from anywhere; paths are resolved relative to this file:
    python3 example_flowgraphs/hrpt/gen_synthetic_symbols.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]

HRPT_SYNC = [0x0284, 0x016F, 0x035C, 0x019D, 0x020F, 0x0095]
MINOR_FRAME_WORDS = 11090
SYNC_WORDS = 6
BITS_PER_WORD = 10
VIDEO_START = 750  # 0-indexed word offset (word 751, 1-indexed)
IMAGE_WIDTH = 2048
IMAGE_LINES = 32  # scan lines (minor frames) to generate
CHANNEL = 2  # 1..5, our hrpt_image_sink default
ADDR = 14  # NOAA-19, per noaa_hrpt_decoder_impl.cc's hrpt_ids[]

HRPT_MINOR_FRAME_SYNC = 0x0A116FD719D83C95


def build_frame(mfnum: int, video_row: np.ndarray) -> list[int]:
    words = [0] * MINOR_FRAME_WORDS
    words[0:6] = HRPT_SYNC
    # ID word (word 7, index 6): mfnum bits 8-7 (mask 0x180>>7), addr bits 6-3
    # (mask 0x078>>3); mfnum cycles 1..4 as noaa_hrpt_decoder_impl.cc expects.
    words[6] = ((mfnum & 0x3) << 7) | (ADDR << 3)
    for i in range(IMAGE_WIDTH):
        words[VIDEO_START + i * 5 + (CHANNEL - 1)] = int(video_row[i])
    return words


def biphase_encode(words: list[int]) -> list[int]:
    """MSB-first bit-serialize, then biphase-L (split-phase) encode: each data
    bit -> 2 channel symbols, bit b -> [1-b, b]. This exact pairing (not
    [b, 1-b]) is what round-trips through noaa_hrpt_deframer_impl.cc's
    mid-bit-transition acquisition logic -- verified below, not assumed.
    """
    bits = []
    for w in words:
        for b in range(BITS_PER_WORD - 1, -1, -1):
            bits.append((w >> b) & 1)
    symbols = []
    for b in bits:
        symbols.append(1 - b)
        symbols.append(b)
    return symbols


def replay_deframer(syms: list[int]) -> list[int]:
    """Python port of noaa_hrpt_deframer_impl::general_work (see
    gr-hrpt/lib/noaa_hrpt_deframer_impl.cc). Returns the decoded words.
    """
    ST_IDLE, ST_SYNCED = 0, 1
    state = ST_IDLE
    mid_bit = True
    last_bit = 0
    shifter = 0
    word = 0
    bit_count = 0
    word_count = 0
    out = []

    def enter_synced():
        nonlocal state, bit_count, word_count, word
        state = ST_SYNCED
        bit_count = BITS_PER_WORD
        word_count = MINOR_FRAME_WORDS - SYNC_WORDS
        word = 0

    for bit in syms:
        diff = bit ^ last_bit
        last_bit = bit
        if mid_bit and (diff or state == ST_SYNCED):
            if state == ST_IDLE:
                shifter = ((shifter << 1) | bit) & ((1 << 60) - 1)
                if shifter == HRPT_MINOR_FRAME_SYNC:
                    out.extend(HRPT_SYNC)
                    enter_synced()
            elif state == ST_SYNCED:
                word = (word << 1) | bit
                bit_count -= 1
                if bit_count == 0:
                    out.append(word)
                    word = 0
                    bit_count = BITS_PER_WORD
                    word_count -= 1
                    if word_count == 0:
                        state = ST_IDLE
            mid_bit = False
        else:
            mid_bit = True
    return out


def main() -> None:
    img = Image.open(REPO_ROOT / 'editor/public/example_images/gnuradio_logo.png').convert('L')
    img = img.resize((IMAGE_WIDTH, IMAGE_LINES), Image.LANCZOS)
    rows8 = np.asarray(img, dtype=np.uint32)  # (IMAGE_LINES, IMAGE_WIDTH), 0..255
    rows10 = rows8 * 1023 // 255  # 0..1023

    all_symbols: list[int] = []
    for line in range(IMAGE_LINES):
        words = build_frame(line + 1, rows10[line])
        symbols = biphase_encode(words)

        # Verify this frame round-trips byte-for-byte, including its pixel
        # row, before it ever reaches a .bin a flowgraph will actually play
        # back -- this is what makes the fixture trustworthy rather than
        # merely plausible.
        decoded = replay_deframer(symbols)
        assert decoded == words, f'round-trip mismatch on line {line}'
        recovered = [decoded[VIDEO_START + i * 5 + (CHANNEL - 1)] for i in range(IMAGE_WIDTH)]
        assert recovered == list(int(v) for v in rows10[line])

        all_symbols.extend(symbols)

    print(f'{IMAGE_LINES} lines, round-trip + channel extraction OK')

    out_path = REPO_ROOT / 'example_flowgraphs/hrpt/noaa_synthetic_symbols.bin'
    out_path.write_bytes(bytes(all_symbols))
    print('total symbols:', len(all_symbols))
    print('wrote', out_path, len(all_symbols), 'bytes')


if __name__ == '__main__':
    main()
