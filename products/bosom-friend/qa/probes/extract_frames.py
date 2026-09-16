"""Extract frames and scene-cut statistics from a video file using PyAV.

Usage:
    python extract_frames.py <video> --times 0,30,60 --out DIR
    python extract_frames.py <video> --count 16 --out DIR
    python extract_frames.py <video> --cuts

Requires: pip install av pillow
"""

import argparse
import os
import sys

import av


def _open(path):
    container = av.open(path)
    if not container.streams.video:
        raise SystemExit(f"no video stream in {path}")
    return container, container.streams.video[0]


def probe(path):
    """Print codec, resolution, frame rate, duration, and audio summary."""
    container, vs = _open(path)
    duration = float(vs.duration * vs.time_base) if vs.duration else None
    print(f"codec:        {vs.codec_context.name}")
    print(f"resolution:   {vs.codec_context.width}x{vs.codec_context.height}")
    print(f"fps:          {vs.average_rate}")
    print(f"duration_s:   {round(duration, 2) if duration else None}")
    print(f"pix_fmt:      {vs.codec_context.pix_fmt}")
    print(f"container:    {container.format.name}")
    audio = container.streams.audio
    if audio:
        a = audio[0]
        print(f"audio:        {a.codec_context.name} {a.codec_context.sample_rate}Hz ch={a.codec_context.channels}")
    else:
        print("audio:        none in this file")


def extract_at(path, times, out_dir):
    """Save one PNG per requested timestamp (first frame at or after each time)."""
    container, vs = _open(path)
    os.makedirs(out_dir, exist_ok=True)
    tb = vs.time_base
    pending = sorted(times)
    idx = 0
    saved = 0
    for frame in container.decode(vs):
        if idx >= len(pending):
            break
        t = float(frame.pts * tb) if frame.pts is not None else 0.0
        if t >= pending[idx]:
            out = os.path.join(out_dir, f"t{pending[idx]:07.2f}.png".replace(".", "_", 1))
            frame.to_image().save(out)
            print(f"saved {out} (requested {pending[idx]}s, actual {t:.2f}s)")
            idx += 1
            saved += 1
    print(f"total_saved: {saved}/{len(pending)}")


def extract_even(path, count, out_dir):
    """Save count frames spaced evenly across the duration."""
    container, vs = _open(path)
    duration = float(vs.duration * vs.time_base) if vs.duration else 0.0
    if duration <= 0:
        raise SystemExit("duration unknown; use --times")
    times = [duration * i / count for i in range(count)]
    extract_at(path, times, out_dir)


def detect_cuts(path, threshold=55.0, size=(80, 45)):
    """Report scene cuts as timestamps where mean abs frame delta exceeds threshold."""
    container, vs = _open(path)
    tb = vs.time_base
    prev = None
    cuts = []
    total = 0
    for frame in container.decode(vs):
        total += 1
        px = frame.to_image().convert("L").resize(size).tobytes()
        t = float(frame.pts * tb) if frame.pts is not None else 0.0
        if prev is not None:
            delta = sum(abs(a - b) for a, b in zip(px, prev)) / len(px)
            if delta > threshold:
                cuts.append(round(t, 2))
        prev = px
    print(f"decoded_frames: {total}")
    print(f"cut_count:      {len(cuts)}")
    if len(cuts) > 1:
        gaps = [round(b - a, 2) for a, b in zip(cuts, cuts[1:])]
        print(f"avg_shot_len_s: {round(sum(gaps) / len(gaps), 2)}")
    print(f"cuts:           {cuts}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video")
    parser.add_argument("--times", help="comma-separated seconds")
    parser.add_argument("--count", type=int, help="evenly spaced frame count")
    parser.add_argument("--cuts", action="store_true", help="report scene cuts")
    parser.add_argument("--out", default="frames", help="output directory")
    args = parser.parse_args(argv)

    probe(args.video)
    print()
    if args.cuts:
        detect_cuts(args.video)
    if args.times:
        extract_at(args.video, [float(x) for x in args.times.split(",")], args.out)
    elif args.count:
        extract_even(args.video, args.count, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
