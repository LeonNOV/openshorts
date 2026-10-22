#!/bin/bash
# End-to-end smoke test for the installed DW-shorts desktop app.
#
# Verifies the two things that were broken:
#   1. the backend starts and serves /health
#   2. a processing job actually finds main.py and starts the pipeline
#
# Usage: bash scripts/desktop_smoke_test.sh [port]
set -u

PORT="${1:-48152}"
BASE="http://127.0.0.1:${PORT}"
APP="/Applications/DW-shorts.app"
RES="${APP}/Contents/Resources"
DATA="${HOME}/Library/Application Support/dw-shorts"

say() { printf '\n=== %s ===\n' "$1"; }

say "backend health"
if ! curl -fsS --max-time 5 "${BASE}/health"; then
  echo "  FAIL: the backend is not answering on ${PORT}"
  exit 1
fi
echo

say "the app runs ITS OWN backend (not a stale one)"
# Find the process LISTENING on our port, then check where its binary lives.
# (lsof rather than ps: ps can be denied in a sandbox.)
BACKEND_PID="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -z "${BACKEND_PID}" ]; then
  echo "  FAIL: nothing is listening on ${PORT}"
  exit 1
fi
BACKEND_BIN="$(lsof -nP -a -p "${BACKEND_PID}" 2>/dev/null | grep -oE '/[^ ]*python3?(\.12)?$' | head -1)"
if ! printf '%s' "${BACKEND_BIN}" | grep -q "DW-shorts.app/Contents/Resources"; then
  echo "  FAIL: the backend on ${PORT} is not the bundled one: ${BACKEND_BIN}"
  exit 1
fi
echo "  OK: pid ${BACKEND_PID} -> ${BACKEND_BIN}"

say "a job finds main.py and starts the pipeline"
SRC="$(ls "${DATA}/uploads/"*.mp4 2>/dev/null | head -1)"
if [ -z "${SRC}" ]; then
  echo "  SKIP: no uploaded video in ${DATA}/uploads to run"
  exit 0
fi
OUT="${DATA}/output/_smoke"
rm -rf "${OUT}"; mkdir -p "${OUT}"
cd "${DATA}" || exit 1
export PYTHONPATH="${RES}/app_src"
export DW_SHORTS_BUNDLE="${RES}"
export DW_SHORTS_DATA_DIR="${DATA}"
"${RES}/python/bin/python" -u "${RES}/app_src/main.py" \
  -i "${SRC}" -o "${OUT}" --format vertical > /tmp/dw_smoke.log 2>&1 &
JOB_PID=$!
for _ in $(seq 1 24); do
  sleep 1
  if grep -qE "Transcribing|🎬|No such file" /tmp/dw_smoke.log 2>/dev/null; then break; fi
done
kill "${JOB_PID}" 2>/dev/null
if grep -q "can't open file" /tmp/dw_smoke.log; then
  echo "  FAIL: the job could not find main.py"
  grep "can't open file" /tmp/dw_smoke.log | head -2
  exit 1
fi
if grep -qE "Transcribing" /tmp/dw_smoke.log; then
  echo "  OK: the pipeline started"
  grep -E "Transcribing|🎬" /tmp/dw_smoke.log | head -3
else
  echo "  FAIL: the pipeline produced no progress"
  head -12 /tmp/dw_smoke.log
  exit 1
fi
rm -rf "${OUT}"
echo
echo "SMOKE TEST: PASS"
