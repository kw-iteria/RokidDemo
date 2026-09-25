#!/usr/bin/env bash
# Regenerates 1-fps benchmark frames from the demo clip (used by tools/bench.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bench-results/frames_480
ffmpeg -v error -y -i assets/press_demo_640.mp4 -vf "fps=1,scale=480:-2" -q:v 4 bench-results/frames_480/f_%03d.jpg
ls bench-results/frames_480 | wc -l
