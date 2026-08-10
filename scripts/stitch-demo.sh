#!/usr/bin/env bash
#
# Stitches the raw Playwright captures into one MP4:
#
#   Part 1  owner | editor, side by side — the approval happens in the right
#           window and the left one advances on its own
#   Part 2  the Org B window failing to reach anything of Org A's
#
# Role labels are burned into the pages themselves at capture time rather than
# drawn here, because ffmpeg's drawtext filter needs a freetype build that is
# not always present.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="recordings"
OWNER="$(find "$OUT/owner" -name '*.webm' | head -1)"
EDITOR="$(find "$OUT/editor" -name '*.webm' | head -1)"
ORGB="$(find "$OUT/orgb" -name '*.webm' | head -1)"

for f in "$OWNER" "$EDITOR" "$ORGB"; do
  [ -f "$f" ] || { echo "missing capture: run scripts/record-demo.mjs first" >&2; exit 1; }
done

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
OWNER_D=$(dur "$OWNER"); EDITOR_D=$(dur "$EDITOR")
echo "owner ${OWNER_D}s | editor ${EDITOR_D}s"

# Both panes must last as long as the longer one, so neither freezes early.
LONGEST=$(python3 -c "print(max($OWNER_D, $EDITOR_D))")

echo "==> part 1: side by side"
ffmpeg -y -loglevel error \
  -i "$OWNER" -i "$EDITOR" \
  -filter_complex "\
    [0:v]tpad=stop_mode=clone:stop_duration=60,trim=duration=${LONGEST},setpts=PTS-STARTPTS,scale=1280:800[l];\
    [1:v]tpad=stop_mode=clone:stop_duration=60,trim=duration=${LONGEST},setpts=PTS-STARTPTS,scale=1280:800[r];\
    [l][r]hstack=inputs=2,scale=1920:-2,fps=12[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -crf 26 -preset veryfast "$OUT/part1.mp4"

echo "==> part 2: cross-org isolation"
ffmpeg -y -loglevel error -i "$ORGB" \
  -filter_complex "\
    [0:v]scale=1280:800,pad=2560:800:(ow-iw)/2:0:color=0x08090B,scale=1920:-2,fps=12[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -crf 26 -preset veryfast "$OUT/part2.mp4"

echo "==> joining"
printf "file '%s'\nfile '%s'\n" "$PWD/$OUT/part1.mp4" "$PWD/$OUT/part2.mp4" > "$OUT/list.txt"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$OUT/list.txt" -c copy "$OUT/agentflow-final-task.mp4"

rm -f "$OUT/part1.mp4" "$OUT/part2.mp4" "$OUT/list.txt"
ls -lh "$OUT/agentflow-final-task.mp4"
echo "done"
