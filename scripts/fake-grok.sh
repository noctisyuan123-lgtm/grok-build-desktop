#!/usr/bin/env bash
# Mimics `grok --output-format streaming-json` for tests.
# Emits a fixed sequence of NDJSON events with a short delay.
# Usage: fake-grok.sh [--ok|--fail|--hang|--slow|--mixed] [--resume SESSION]...
set -euo pipefail

mode="--ok"
resume_session=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ok|--fail|--hang|--slow|--mixed)
      mode="$1"
      shift
      ;;
    --resume)
      resume_session="${2:-}"
      shift 2
      ;;
    *)
      # Ignore unknown flags (forward-compat with real CLI arg noise).
      if [[ "${2-}" == -* || -z "${2-}" ]]; then
        shift
      else
        shift 2
      fi
      ;;
  esac
done

emit() { printf '%s\n' "$1"; sleep 0.02; }

case "$mode" in
  --ok|"")
    emit '{"type":"thought","data":"thinking"}'
    if [[ -n "$resume_session" ]]; then
      emit "{\"type\":\"text\",\"data\":\"resume:${resume_session}\"}"
      emit "{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"sessionId\":\"${resume_session}\",\"requestId\":\"req-1\"}"
    else
      emit '{"type":"text","data":"hello"}'
      emit '{"type":"text","data":" world"}'
      emit '{"type":"end","stopReason":"EndTurn","sessionId":"sess-1","requestId":"req-1"}'
    fi
    ;;
  --fail)
    emit '{"type":"thought","data":"trying"}'
    >&2 echo "fake-grok: simulated failure"
    exit 2
    ;;
  --hang)
    emit '{"type":"thought","data":"hanging"}'
    sleep 600
    ;;
  --slow)
    emit '{"type":"thought","data":"slow start"}'
    sleep 3
    emit '{"type":"text","data":"finally"}'
    emit '{"type":"end","stopReason":"EndTurn","sessionId":"sess-slow","requestId":"req-slow"}'
    ;;
  --mixed)
    emit '{"type":"thought","data":"start"}'
    emit '{"type":"future_event","data":"unknown payload"}'
    emit '{"not":"json valid for our schema either"}'
    echo 'plain text garbage'
    emit '{"type":"text","data":"recovered"}'
    emit '{"type":"end","stopReason":"EndTurn","sessionId":"s","requestId":"r"}'
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
