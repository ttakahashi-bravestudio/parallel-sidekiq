#!/bin/bash

# 現在時刻（UTC）を取得
now=$(date -u +%s)

# 4日前（秒単位）
threshold=$((now - 4 * 24 * 60 * 60))

# すべてのキーを取得
aws kms list-keys --query 'Keys[*].KeyId' --output text | tr '\t' '\n' | while read key_id; do
  # キーのメタデータを取得
  metadata=$(aws kms describe-key --key-id "$key_id" --query 'KeyMetadata')
  
  # 作成日を秒で取得
  creation_date=$(echo "$metadata" | jq -r '.CreationDate' | xargs -I{} date -d {} +%s)
  
  # 判定
  if [ "$creation_date" -ge "$threshold" ]; then
    echo "✅ 4日以内に作成: $key_id"
    
    # オプション: 削除スケジュール（必要な場合はコメントアウトを解除）
    aws kms schedule-key-deletion --key-id "$key_id" --pending-window-in-days 7
  fi
done
