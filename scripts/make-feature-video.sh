#!/usr/bin/env bash
# Assembles assets/feature-tour.mp4 from the raw material recorded by
# test/feature-video.mjs:
#   title card → scene1 (act + approve) → scene2 (vision/screenshot)
#   → scene3 (multi-tab) → scene4 (workflow record) → model card → end card
# Each scene is an hstack of its page+panel recordings, aligned at their
# common END (the pair closes together).
#
# Usage:  [FFMPEG=/path/to/ffmpeg] scripts/make-feature-video.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FFMPEG="${FFMPEG:-ffmpeg}"
RAW=assets/video-raw
OUT=assets/feature-tour.mp4
[ -f "$RAW/scene1-page.webm" ] || { echo "run: xvfb-run -a node test/feature-video.mjs first"; exit 1; }

# ffmpeg -i with no output exits 1 by design — don't let pipefail kill us.
dur() { ("$FFMPEG" -i "$1" 2>&1 || true) | grep -oE "Duration: [0-9:.]+" | sed -E 's/Duration: //; s/^0?0:0?0://' ; }

INPUTS=(-loop 1 -t 3.0 -i "$RAW/card-title.png")
FILTER="[0:v]scale=1280:720,fps=25,format=yuv420p,setsar=1,fade=t=in:st=0:d=0.4[c0];"
CONCAT="[c0]"
idx=1
for n in 1 2 3 4; do
  DP=$(dur "$RAW/scene$n-page.webm"); DN=$(dur "$RAW/scene$n-panel.webm")
  D=$(python3 -c "print(f'{min($DP,$DN)-0.15:.2f}')")
  echo "scene$n: page=${DP}s panel=${DN}s → tail ${D}s"
  INPUTS+=(-sseof -"$D" -i "$RAW/scene$n-page.webm" -sseof -"$D" -i "$RAW/scene$n-panel.webm")
  FILTER+="[$idx:v]fps=25[p$n];[$((idx+1)):v]fps=25[q$n];[p$n][q$n]hstack=inputs=2,format=yuv420p,setsar=1[s$n];"
  CONCAT+="[s$n]"
  idx=$((idx+2))
done
INPUTS+=(-loop 1 -t 3.5 -i "$RAW/card-model.png" -loop 1 -t 3.5 -i "$RAW/card-end.png")
FILTER+="[$idx:v]scale=1280:720,fps=25,format=yuv420p,setsar=1[c1];"
FILTER+="[$((idx+1)):v]scale=1280:720,fps=25,format=yuv420p,setsar=1,fade=t=out:st=3.0:d=0.5[c2];"
FILTER+="${CONCAT}[c1][c2]concat=n=7:v=1:a=0[v]"

"$FFMPEG" -y "${INPUTS[@]}" -filter_complex "$FILTER" \
  -map "[v]" -c:v libx264 -crf 20 -preset medium -movflags +faststart "$OUT" 2>/dev/null

("$FFMPEG" -i "$OUT" 2>&1 || true) | grep -E "Duration|Stream" | head -2
ls -lh "$OUT"
