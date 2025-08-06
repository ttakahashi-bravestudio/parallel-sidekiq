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
# ECS設定
ECS_CLUSTER=your-cluster-name
ECS_SIDEKIQ_TASK_DEFINITION=your-task-definition
ECS_SIDEKIQ_SUBNET_IDS=subnet-xxx,subnet-yyy
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
