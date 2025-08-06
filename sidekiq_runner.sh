#!/bin/bash
set -euo pipefail

# 環境変数のデフォルト値を設定
QUEUE="${QUEUE:-default}"
CONCURRENCY="${CONCURRENCY:-10}"

# Sidekiqを起動
exec bundle exec sidekiq -q "$QUEUE" -c "$CONCURRENCY" 