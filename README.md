<<<<<<< HEAD
# Pallarel Sidekiq - CSV処理システム

このアプリケーションは、CSVファイルの並列処理を行うRailsアプリケーションです。mainブランチとstaging-cronブランチでは、ローカル環境とAWS環境での動作に大きな違いがあります。

## 概要

### mainブランチ
- 基本的なRailsアプリケーション
- シンプルなSidekiqジョブ処理
- ローカル開発環境向け

### staging-cronブランチ
- **CSV並列処理システム**の実装
- **AWS ECS Fargate**を使用した動的ワーカー起動
- **トークンベースのキュー分離**による並列処理
- **自動リソース管理**（アイドル時の自動停止）

## 主要機能

### 1. CSVファイル処理
- CSVファイルのアップロード機能
- 行単位での並列処理
- 処理状況のリアルタイム監視
- 結果ファイルのZIP圧縮と保存

### 2. トークンベースのキュー分離
```ruby
# 各処理にユニークなトークンを割り当て
token = SecureRandom.uuid
queue = QueueRouter.for_token(token) # "report-<SHA1ハッシュ>"
```

**トリガーとなるジョブは"report"キューで処理される**
- `SplitCsvJob`: CSV分割とワーカー起動のトリガー
- `FinalizeReportJob`: 処理完了とリソース解放のトリガー（開始のみ、再実行はSelf）

### 3. 動的ワーカー起動（AWS環境のみ）
- 処理開始時にECS Fargateタスクを動的に起動
- トークンごとに専用ワーカーを割り当て
- 処理完了後の自動停止

## アーキテクチャ

### ローカル環境（LOCAL_SAVE=true）
```
Web App → Redis → Worker Container (per queue) → ローカルファイル保存
```

### AWS環境（LOCAL_SAVE=false）
```
Web App → Redis → ECS Fargate → S3保存
```

## 環境別の動作の違い

### ローカル環境
- **LOCAL_SAVE=true** 環境変数で制御
- ファイルはローカルファイルシステムに保存
- 処理するキューごとにworkerコンテナを実行する必要がある
- ECSタスクは起動されない

### AWS環境
- **LOCAL_SAVE=false** または未設定
- ファイルはS3に保存
- トークンごとに専用ECS Fargateタスクを起動
- 処理完了後の自動リソース解放

## 主要コンポーネント

### 1. コントローラー
- `CsvProcessingController`: CSVアップロードと処理状況表示

### 2. ジョブ
- `SplitCsvJob`: CSV分割とワーカー起動
- `ProcessCsvRowJob`: 行単位処理
- `FinalizeReportJob`: 処理完了とリソース解放
- `IdleShutdownJob`: アイドル時の自動停止

### 3. サービス
- `EcsTaskLauncher`: ECSタスクの起動・停止管理
- `QueueRouter`: トークンベースのキュー名生成

### 4. モデル
- `CsvProcessingStatus`: 処理状況の追跡
- `ClientReport`: レポート情報の管理

## 設定

### 必要な環境変数（AWS環境）

```bash
=======
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

>>>>>>> staging
# ECS設定
ECS_CLUSTER=your-cluster-name
ECS_SIDEKIQ_TASK_DEFINITION=your-task-definition
ECS_SIDEKIQ_SUBNET_IDS=subnet-xxx,subnet-yyy
<<<<<<< HEAD
ECS_SIDEKIQ_SECURITY_GROUP_IDS=sg-xxx,sg-yyy

# S3設定
AWS_REGION=ap-northeast-1
AWS_S3_BUCKET=your-bucket-name

# ローカル環境
LOCAL_SAVE=true  # ローカルファイル保存を有効化
```

### Sidekiq設定
- キュー分離の強制検証
- トークンベースのキュー名生成
- 並列処理の安全性確保

## デプロイメント

### Docker Compose（開発環境）
```bash
docker-compose up
```

## 処理フロー

1. **CSVアップロード**
   - ユーザーがCSVファイルをアップロード
   - ユニークなトークンが生成される

2. **CSV分割**
   - `SplitCsvJob`がCSVを行単位に分割
   - 各行を専用キューにエンキュー

3. **ワーカー起動（AWS環境のみ）**
   - `EcsTaskLauncher`が専用ECSタスクを起動
   - トークンごとに分離されたワーカー

4. **並列処理**
   - 各ワーカーが専用キューからジョブを取得
   - 行単位で並列処理を実行

5. **完了処理**
   - `FinalizeReportJob`が結果をZIP圧縮
   - S3またはローカルに保存
   - ECSタスクを自動停止

## 監視とログ

- Sidekiq Web UI: `/sidekiq`
- 処理状況表示: `/csv_processing/status`
- 詳細状況: `/csv_processing/:token`

## 開発・テスト

```bash
# Sidekiq起動
bundle exec sidekiq -C config/sidekiq.yml

# 開発サーバー起動
bin/dev

# ローカルでのレポート処理
# 特定のキューを処理するワーカーを起動（キューごとに別コンテナが必要）
docker compose run worker bundle exec sidekiq -q "report-<SHA1ハッシュ>" -c 10
```

## 注意事項

- **ローカル環境**では`LOCAL_SAVE=true`を設定
- **AWS環境**では適切なIAM権限が必要
- **ECSタスク定義**は事前に作成が必要
- **S3バケット**は適切な権限設定が必要
=======
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
docker-compose logs -f sidekiq | grep ecs-monitor

# または個別のコンテナで
docker logs <sidekiq-container-name> | grep ecs-monitor

# Cronジョブの状態確認
docker-compose exec sidekiq crontab -l
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

#### 開発環境（docker-compose）

```bash
# 全サービスを起動（Rails + Sidekiq + DB + Redis）
docker-compose up

# バックグラウンドで起動
docker-compose up -d

# 特定のサービスのみ起動
docker-compose up web        # Railsアプリのみ
docker-compose up sidekiq    # Sidekiqのみ

# ログ確認
docker-compose logs -f web
docker-compose logs -f sidekiq
```

#### 本番環境

```bash
# Railsアプリ用イメージをビルド
docker build -t pallarel-sidekiq-web .

# Sidekiq用イメージをビルド
docker build -f Dockerfile.sidekiq -t pallarel-sidekiq-worker .

# 個別に実行
docker run -p 3000:3000 pallarel-sidekiq-web
docker run pallarel-sidekiq-worker
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
>>>>>>> staging
