#!/usr/bin/env bash
# ターミナルから指定した部署のPMに話しかける。ブラウザからの指示と同じセッション
# （記憶）を共有する。
# 使い方: ./talk_to.sh <AGENT_ID>   (例: P, D, M, S)
# 注意: 同じエージェントに対してブラウザ経由の指示とこのスクリプトを同時に使わない
# こと（同じセッションへの書き込みが競合する可能性があります）。
cd "$(dirname "$0")"
AGENT_ID="${1:?使い方: ./talk_to.sh <AGENT_ID> (例: P, D, M, S)}"
mkdir -p state/sessions

# 内部ID(セッションファイル名・env var用)と、実際の人物名(souls/*.md用)の対応。
case "$AGENT_ID" in
  P) SOUL_NAME="発田案" ;;
  D) SOUL_NAME="築山創" ;;
  M) SOUL_NAME="広瀬映" ;;
  S) SOUL_NAME="ユイ" ;;
  *) SOUL_NAME="$AGENT_ID" ;;
esac

SESSION_FILE="state/sessions/${AGENT_ID}.txt"
SOUL_FILE="souls/${SOUL_NAME}.md"
PROMPT_FILE="prompts/${AGENT_ID}.txt"
export AI_MIERUKA_AGENT="$AGENT_ID"

SYSTEM_PROMPT=""
if [ -f "$SOUL_FILE" ]; then
  SYSTEM_PROMPT="$(cat "$SOUL_FILE")"
fi
if [ -f "$PROMPT_FILE" ]; then
  SYSTEM_PROMPT="${SYSTEM_PROMPT}

$(cat "$PROMPT_FILE")"
fi

SYSTEM_PROMPT_ARGS=()
if [ -n "$SYSTEM_PROMPT" ]; then
  SYSTEM_PROMPT_ARGS=(--append-system-prompt "$SYSTEM_PROMPT")
fi

if [ -f "$SESSION_FILE" ]; then
  SID=$(cat "$SESSION_FILE")
  echo "${SOUL_NAME}のセッションに接続します (session: $SID)"
  exec claude --resume "$SID" "${SYSTEM_PROMPT_ARGS[@]}"
else
  SID=$(python3 -c "import uuid; print(uuid.uuid4())")
  echo "$SID" > "$SESSION_FILE"
  echo "${SOUL_NAME}の新しいセッションを開始します (session: $SID)"
  exec claude --session-id "$SID" "${SYSTEM_PROMPT_ARGS[@]}"
fi
