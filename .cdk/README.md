# dajp_php83 インフラストラクチャ用 CDK プロジェクト

この README は、AWS CDK と Docker Compose を使用して `dajp_php83` プロジェクトの AWS インフラストラクチャを構築、デプロイ、管理する手順の概要を説明します。

**場所:** 特に指定がない限り、すべてのコマンドは `.cdk` ディレクトリ (`/dajp_php83/.cdk/`) から実行する必要があります。

## ワークフロー

### 1. Docker Compose で Docker イメージをビルド

アプリケーション環境は Docker Compose を使用してビルドできます。このステップは、CDK スタックが AWS Fargate などのサービスにローカルの Docker アセットを使用する場合に不可欠です。

```bash
# まだ .cdk ディレクトリにいない場合は移動します:
# cd ./.cdk/

# compose.yml ファイルを使用して Docker イメージをビルドします:
docker compose -f compose.yml build
```

### 2. AWS CDK でインフラストラクチャをデプロイ

AWS CDK を使用してインフラストラクチャをデプロイするには、次の手順に従います。

**前提条件:**
*   適切な認証情報とリージョンで設定された AWS CLI。
*   Node.js と npm がインストールされていること。

**手順:**

1.  **依存関係のインストール:**
    初めての場合、または依存関係が変更された場合:
    ```bash
    docker compose run --rm cdk npm install
    ```

2.  **CloudFormation テンプレートの合成 (オプション):**
    デプロイ前に CloudFormation テンプレートを確認する場合:
    ```bash
    docker compose run --rm cdk cdk synth
    ```

3.  **デプロイ済みスタックとの比較 (オプション):**
    ローカルの CDK コードと現在デプロイされているスタックの違いを確認する場合:
    ```bash
    docker compose run --rm cdk cdk diff
    ```

4.  **スタックのデプロイ:**
    このコマンドは、AWS のインフラストラクチャをプロビジョニングまたは更新します。
    ```bash
    docker compose run --rm cdk cdk deploy
    ```

### 初回デプロイ時の重要な注意点

初回デプロイ時、ECSコンテナイメージはダミーイメージが設定されており、ECSサービスの「必要タスク数」は0に設定されています。
CDKによるインフラのデプロイ完了後、以下の手順で実際のアプリケーションイメージを反映し、サービスを開始してください。

1.  **CodePipeline の実行:** CodePipeline を手動で実行するか、コミット等でトリガーしてアプリケーションのビルドとコンテナイメージの作成・ECRへのプッシュを行います。
2.  **タスク定義の確認/更新:** CodePipeline によって新しいイメージが ECR にプッシュされると、通常、CodePipelineがECSのタスク定義を新しいイメージバージョン（または `latest` タグ）を指すように更新します。この更新が適用されていることを確認してください。場合によっては手動での更新や確認が必要です。
3.  **ECS サービス更新 (必要タスク数の変更):** AWS マネジメントコンソール、AWS CLI、または SDK を使用して、対象の ECS サービスの「必要タスク数」(desired count) を1以上に更新します。これにより、更新されたタスク定義に基づいたコンテナが起動し、サーバーが稼働状態になります。

**注意:** 上記の手順は、CDKスタックが CodePipeline を含み、かつECSサービスが初回デプロイ時にダミーイメージと必要タスク数0でセットアップされるように構成されていることを前提としています。実際の構成に合わせて手順を調整してください。

### 環境変数 `ENVIRONMENT` による設定変更

CDKスタックは、デプロイ時に指定される環境変数 `ENVIRONMENT` の値によって、作成されるリソースの構成が一部変更されます。特に `ENVIRONMENT` を `"production"` に設定した場合、以下の点が変更されます。

*   **NATゲートウェイの利用:**
    *   開発環境 (`dev` など): コスト削減のためNATインスタンスが使用されます。
    *   本番環境 (`production`): より可用性と帯域幅に優れたNATゲートウェイが使用されます。
*   **RDSインスタンスのスペック:**
    *   開発環境: より小規模なインスタンスタイプ (例: `t3.micro` や `t4g.micro` など、CDKコードで定義されたデフォルト)。
    *   本番環境: `db.t4g.small` インスタンスタイプにアップグレードされます。
*   **RDSパフォーマンスインサイト:**
    *   開発環境: 無効。
    *   本番環境: 有効になり、データベースのパフォーマンス分析が詳細に行えるようになります。
*   **RDSのバックアップとマルチAZ:**
    *   開発環境: 自動バックアップは無効または短期間、マルチAZは無効。
    *   本番環境: 自動バックアップが有効 (例: 7日間保持)、マルチAZ構成が有効になり、データベースの可用性と耐久性が向上します。

本番環境へデプロイする場合は、以下の手順で `compose.yml` ファイルを編集し、その後通常のデプロイコマンドを実行します。

1.  `.cdk/compose.yml` ファイルを開きます。
2.  `services` -> `cdk` -> `environment` セクションにある `ENVIRONMENT` 変数の値を `"production"` に変更します。
    ```yaml
    services:
      cdk:
        # ... 他の設定 ...
        environment:
          ENVIRONMENT: "production" # ← この値を "production" に変更
          # ... 他の環境変数 ...
    ```
3.  ファイルを保存します。
4.  通常のデプロイコマンドを実行します:
    ```bash
    docker compose run --rm cdk cdk deploy
    ```

**重要な注意:** 本番環境へのデプロイ完了後、誤って再度本番環境へデプロイしてしまうことを防ぐため、`compose.yml` ファイルの `ENVIRONMENT` 変数を元の値 (例: `"staging"`) に戻しておくことを強く推奨します。

### 3. ECS Exec で実行中のコンテナにアクセス

ECS サービスとタスクが実行されたら、ECS Exec を使用してコンテナ内でコマンドを実行したり、シェルセッションを開始したりできます。

**前提条件:**
*   AWS CLI がインストールされ、設定されていること。
*   AWS CLI 用 Session Manager Plugin がインストールされていること。
*   IAM 権限:
    *   ECS タスクロールには `AmazonSSMManagedInstanceCore` などの権限が必要です。
    *   コマンドを実行する IAM ユーザー/ロールには `ecs:ExecuteCommand` 権限が必要です。
*   ECS タスク設定:
    *   ECS タスク定義で `enableExecuteCommand` プロパティを `true` に設定する必要があります。

**接続手順:**

1.  **ターゲット情報の特定:**
    *   **クラスター名:** ECS クラスターの名前 (例: `dajp-dev-cluster`)。これは通常、CDK スタックで定義されるか、AWS ECS コンソールで見つけることができます。
    *   **タスク ID:** 実行中のタスクの ID。タスク ID は動的です。AWS CLI を使用してタスク ID を見つけることができます:
        ```bash
        aws ecs list-tasks --cluster <your-cluster-name> --query "taskArns[0]" --output text | awk -F/ '{print $NF}'
        ```
        `<your-cluster-name>` を実際のクラスター名に置き換えてください。このコマンドは、リストされた最初のタスクの ID を取得します。タスク ID は、クラスターとサービスの下の AWS ECS コンソールでも見つけることができます。
    *   **コンテナ名:** タスク定義で定義されているタスク内のコンテナの名前 (例: `AppContainer`)。

2.  **コマンドの実行:**
    指定されたコンテナでインタラクティブな bash シェルを開始するには:
    ```bash
    aws ecs execute-command \
        --cluster <your-cluster-name> \
        --task <your-task-id> \
        --container <your-container-name> \
        --command "/bin/bash" \
        --interactive
    ```
    **プレースホルダーを使用した例 (実際の値に置き換えてください):**
    ```bash
    aws ecs execute-command \
        --cluster dajp-dev-cluster \
        --task <your-task-id> \
        --container AppContainer \
        --command "/bin/bash" \
        --interactive
    ```

## その他の便利な CDK コマンド

*   `docker compose run --rm cdk npm run test`: プロジェクトで定義された Jest ユニットテストを実行します。