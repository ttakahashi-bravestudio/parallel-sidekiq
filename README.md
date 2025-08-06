# Pallarel Sidekiq

CSVファイル処理とレポート生成を行うRailsアプリケーションです。Sidekiqを使用した非同期処理とECSタスクの自動管理機能を提供します。

## 機能

- CSVファイルの非同期処理
- レポート生成（PDF/XLSX）
- ECSタスクの自動起動・停止
- デッドレターキュー監視
- アイドルECSタスク監視

## システム要件

- Ruby 3.x
- Rails 8.0.2
- Redis
- MySQL
- AWS ECS
- AWS S3

## セットアップ

### 依存関係のインストール

```bash
bundle install
yarn install
```

### データベース設定

```bash
rails db:create
rails db:migrate
rails db:seed
```

### 環境変数設定

```bash
# AWS設定
AWS_REGION=ap-northeast-1
AWS_S3_BUCKET=your-bucket-name

# ECS設定
ECS_CLUSTER=your-cluster-name
ECS_SIDEKIQ_TASK_DEFINITION=your-task-definition
ECS_SIDEKIQ_SUBNET_IDS=subnet-xxx,subnet-yyy
ECS_SIDEKIQ_SECURITY_GROUP_IDS=sg-xxx

# Redis設定
REDIS_URL=redis://localhost:6379

# データベース設定
DB_HOST=localhost
DB_PORT=3306
DB_NAME=pallarel_sidekiq
DB_USER=root
DB_PASSWORD=password
```

## 使用方法

### アプリケーション起動

```bash
# 開発サーバー起動
rails server

# Sidekiq起動
bundle exec sidekiq -C config/sidekiq.yml
```

### CSVファイル処理

1. ブラウザでアプリケーションにアクセス
2. CSVファイルをアップロード
3. 処理タイプ（PDF/XLSX）を選択
4. 処理開始

## ECSタスク監視機能

### 概要

AWS上でSidekiqジョブが例外でリトライを繰り返し、リトライ回数上限に達した際にECSタスクが残ってしまう問題を解決するための監視機能を実装しています。OSベースのCronを使用して定期実行を行います。

### 監視ジョブ

#### 1. デッドレターキュー監視 (`DeadLetterMonitorJob`)
- **実行間隔**: 5分ごと（Cron: `*/5 * * * *`）
- **機能**: デッドレターキューに移動したジョブを検出し、ECSタスクを停止
- **対象**: `Report::FinalizeReportJob`, `Report::ProcessCsvRowJob`

#### 2. 強制終了フラグ監視 (`ForceShutdownMonitorJob`)
- **実行間隔**: 10分ごと（Cron: `*/10 * * * *`）
- **機能**: `force_shutdown_at`フラグが設定されたECSタスクを強制停止
- **方法**: AWS CLIを使用した強制停止

#### 3. アイドルECSタスク監視 (`IdleEcsTaskMonitorJob`)
- **実行間隔**: 15分ごと（Cron: `*/15 * * * *`）
- **機能**: 30分以上アイドル状態のECSタスクを検出し停止
- **条件**: キューの残りジョブ数が0または非常に少ない場合

### 手動実行

```bash
# 全ての監視ジョブを実行
rails monitor:all

# 個別の監視ジョブを実行
rails monitor:dead_letter
rails monitor:force_shutdown
rails monitor:idle_tasks

# ECSタスクの状態確認
rails monitor:check_ecs_tasks
```

### Cronログの確認

```bash
# Cronジョブの実行ログを確認（標準出力に表示）
docker logs <container_name> | grep ecs-monitor

# Cronジョブの状態確認
docker exec <container_name> crontab -l
```

### リトライ設定

各Sidekiqジョブには以下の設定を適用しています：

```ruby
sidekiq_options queue: :report, retry: 3, dead: true
```

- **retry: 3**: リトライ回数を3回に制限（デフォルト25回から削減）
- **dead: true**: リトライ上限に達したジョブをデッドレターキューに移動

### 監視の仕組み

1. **ジョブ失敗時**: 例外発生時にECSタスク停止処理を実行
2. **デッドレター検出**: デッドレターキュー監視でECSタスクを停止
3. **強制終了**: 強制終了フラグ監視でECSタスクを強制停止
4. **アイドル検出**: 長時間アイドル状態のECSタスクを自動停止

## 開発

### テスト実行

```bash
rails test
```

### コード品質チェック

```bash
bundle exec rubocop
bundle exec brakeman
```

## デプロイ

### Docker使用

```bash
# 開発環境
docker-compose up

# 本番環境
docker build -t pallarel-sidekiq .
docker run -p 3000:3000 pallarel-sidekiq
```

### AWS ECS使用

1. ECRにイメージをプッシュ
2. ECSタスク定義を更新
3. サービスをデプロイ

## トラブルシューティング

### ECSタスクが残る場合

1. 監視ジョブの実行状況を確認
```bash
rails monitor:check_ecs_tasks
```

2. 手動で監視ジョブを実行
```bash
rails monitor:all
```

3. ログを確認
```bash
tail -f log/development.log
```

### デッドレターキューが蓄積する場合

1. デッドレターキュー監視ジョブを実行
```bash
rails monitor:dead_letter
```

2. Sidekiq Web UIでデッドレターキューを確認
3. 必要に応じてジョブを削除または再実行

## ライセンス

このプロジェクトはMITライセンスの下で公開されています。
