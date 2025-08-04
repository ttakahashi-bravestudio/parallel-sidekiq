import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as resourcegroups from 'aws-cdk-lib/aws-resourcegroups';
import * as appinsights from 'aws-cdk-lib/aws-applicationinsights';

export interface InfraStackProps extends cdk.StackProps {
  environment: string;
  githubConnectionArn: string;
  githubRepoName: string;
  githubRepoOwner: string;
  s3BucketArn?: string;
  certificateArn: string;
  cpu?: number;
  memoryLimitMiB?: number;
  desiredCount: number;
  contactRecipientEmail?: string;
  bccAddress?: string;
  tokenApiKey?: string;
  sentryDsn?: string;
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    // リソース名生成用のメソッド
    const generateResourceName = (name: string): string => {
      return `dajp-${props.environment.substring(0, 3)}-${name}`.toLowerCase();
    };

    // KMSキーの作成
    const encryptionKey = new kms.Key(this, 'EncryptionKey', {
      enableKeyRotation: true,
      description: `Encryption key for dajp ${props.environment} environment`,
      alias: generateResourceName('encryption-key'),
      // CloudWatch LogsがこのKMSキーを使用できるようにポリシーを追加
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'Enable IAM User Permissions',
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: ['kms:*'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'Allow CloudWatch Logs to use the key',
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
            actions: [
              'kms:Encrypt*',
              'kms:Decrypt*',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:Describe*',
            ],
            resources: ['*'],
            conditions: {
              ArnLike: {
                'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
              },
            },
          }),
        ],
      }),
    });

    // CloudWatch LogsがKMSキーを使用できるようにする追加の許可
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('logs.amazonaws.com')],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
      })
    );

    // NATインスタンスの作成
    const natInstance = ec2.NatProvider.instanceV2({
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({cpuType: ec2.AmazonLinuxCpuType.ARM_64}),
    })

    // VPCの作成
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: generateResourceName('vpc'),
      maxAzs: 2,
      natGateways: 1, // NATデバイス(Instance or Gateway)を常に1つ作成
      natGatewayProvider: props.environment === 'staging' ? natInstance : undefined,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // NATインスタンスのセキュリティグループ
    if (props.environment === 'staging') {
      // インバウンドルールを追加
      natInstance.securityGroup.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.tcp(80),
        'Allow HTTP traffic from VPC'
      );
      natInstance.securityGroup.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.tcp(443),
        'Allow HTTPS traffic from VPC'
      );
      natInstance.securityGroup.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.tcp(587),
        'Allow SMTP traffic from VPC'
      );
    }

    // セキュリティグループの作成
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      securityGroupName: generateResourceName('alb-sg'),
      description: 'Security group for ALB',
      allowAllOutbound: true,
    });

    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      securityGroupName: generateResourceName('ecs-sg'),
      description: 'Security group for ECS tasks',
      allowAllOutbound: true,
    });

    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      securityGroupName: generateResourceName('rds-sg'),
      description: 'Security group for RDS',
      allowAllOutbound: false,
    });

    // Valkeyのセキュリティグループ（本番環境のみ）
    let redisSecurityGroup;
    if (props.environment === 'production') {
      redisSecurityGroup = new ec2.SecurityGroup(this, 'ValkeySecurityGroup', {
        vpc,
        securityGroupName: generateResourceName('valkey-sg'),
        description: 'Security group for Valkey ElastiCache',
        allowAllOutbound: false,
      });
    }

    // セキュリティグループのルール設定
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic'
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8443),
      'Allow HTTPS traffic for blue-green'
    );

    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(80),
      'Allow traffic from ALB'
    );

    rdsSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow MySQL traffic from ECS'
    );

    // Valkey ElastiCacheの作成（本番環境のみ）
    let redis;
    if (props.environment === 'production' && redisSecurityGroup) {
      // サブネットグループの作成
      const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'ValkeySubnetGroup', {
        description: 'Subnet group for Valkey ElastiCache',
        subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
        cacheSubnetGroupName: generateResourceName('valkey-subnet-group'),
      });

      // Valkeyクラスターの作成
      const valkey_description = 'ValkeyElastiCache';
      redis = new elasticache.CfnReplicationGroup(this, "ReplicationGroup", {
        replicationGroupDescription: valkey_description,
        engine: "valkey", // engine は valkey を指定
        engineVersion: "7.2",
        cacheNodeType: "cache.t3.micro",
        cacheSubnetGroupName: redisSubnetGroup.ref,
        cacheParameterGroupName: new elasticache.CfnParameterGroup(this, "ParameterGroup", {
          description: valkey_description,
          cacheParameterGroupFamily: "valkey7" // パラメータグループは valkey7 を指定
        }).ref,
        numNodeGroups: 1,
        replicasPerNodeGroup: 1,
        securityGroupIds: [redisSecurityGroup.securityGroupId],
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
      });

      // Valkeyセキュリティグループのルール設定（本番環境のみ）
      if (redisSecurityGroup) {
        redisSecurityGroup.addIngressRule(
          ecsSecurityGroup,
          ec2.Port.tcp(Number(redis.attrPrimaryEndPointPort) || 6379),
          'Allow Valkey traffic from ECS'
        );
      }
    }

    // ECRリポジトリの作成
    const ecrRepository = new ecr.Repository(this, 'EcrRepository', {
      repositoryName: generateResourceName('app'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageAge: cdk.Duration.days(7),
          tagStatus: ecr.TagStatus.UNTAGGED,
        },
      ],
    });
    
    // ECRリポジトリの作成
    const cronEcrRepository = new ecr.Repository(this, 'CronEcrRepository', {
      repositoryName: generateResourceName('cron'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageAge: cdk.Duration.days(7),
          tagStatus: ecr.TagStatus.UNTAGGED,
        },
      ],
    });

    // ECSクラスターの作成
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: generateResourceName('cluster'),
      containerInsights: true,
    });

    // タスク実行ロールの作成
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // ECS Exec用のポリシーを追加
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel'
        ],
        resources: ['*']
      })
    );

    // タスクロールの作成
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // ECS Exec用のポリシーを追加
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel'
        ],
        resources: ['*']
      })
    );

    // X-Ray用のポリシーを追加
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets'
        ],
        resources: ['*']
      })
    );

    // S3バケットへのアクセス権限を追加
    if (props.s3BucketArn) {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:*'],
          resources: [props.s3BucketArn, `${props.s3BucketArn}/*`],
        })
      );
    }

    // ロググループの作成
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${generateResourceName('app')}`,
      retention: props.environment === 'staging' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_YEAR,
      encryptionKey,
    });

    // RDSインスタンスの作成
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_4_5,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        props.environment === 'production' ? ec2.InstanceSize.SMALL : ec2.InstanceSize.MICRO
      ),
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin'),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      storageEncryptionKey: encryptionKey,
      securityGroups: [rdsSecurityGroup],
      backupRetention: cdk.Duration.days(7),
      preferredBackupWindow: '03:00-04:00',
      preferredMaintenanceWindow: 'Mon:04:00-Mon:05:00',
      multiAz: props.environment === 'production', // 本番環境でのみマルチAZを有効化
      autoMinorVersionUpgrade: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      databaseName: `${generateResourceName('db').replace(/[^a-zA-Z0-9]/g, '')}`, // データベース名から無効な文字を削除
      instanceIdentifier: generateResourceName('db'),
      monitoringInterval: cdk.Duration.minutes(1),
      enablePerformanceInsights: false,
      deleteAutomatedBackups: props.environment !== 'production', // 本番環境以外は自動バックアップを削除
    });


    // Appタスク定義の作成
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      memoryLimitMiB: props.memoryLimitMiB || 1024,
      cpu: props.cpu || 512,
      taskRole,
      executionRole: taskExecutionRole,
      family: generateResourceName('app'),
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    // Appコンテナの定義
    const container = taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs',
        logGroup,
      }),
      portMappings: [{ containerPort: 80 }],
      environment: {
        ENVIRONMENT: props.environment,
        CONTACT_RECIPIENT_EMAIL: props.contactRecipientEmail || '',
        BCC_ADDRESS: props.bccAddress || '',
        TOKEN_API_KEY: props.tokenApiKey || '',
        SENTRY_DSN: props.sentryDsn || '',
        // X-Ray設定（本番環境のみ）
        ...(props.environment === 'production' ? {
          _X_AMZN_TRACE_ID: '',
          AWS_XRAY_TRACING_NAME: 'dajp-app',
          AWS_XRAY_DAEMON_ADDRESS: 'localhost:2000',
          // Valkey設定（本番環境のみ）
          REDIS_HOST: redis ? redis.attrPrimaryEndPointAddress : '',
          REDIS_PORT: redis ? redis.attrPrimaryEndPointPort : '',
          REDIS_URL: redis ? `redis://${redis.attrPrimaryEndPointAddress}:${redis.attrPrimaryEndPointPort}` : ''
        } : {})
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(database.secret!, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(database.secret!, 'port'),
        DB_NAME: ecs.Secret.fromSecretsManager(database.secret!, 'dbname'),
        DB_USER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
    });

    // X-Rayサイドカーコンテナの追加（本番環境のみ）
    if (props.environment === 'production') {
      const xrayContainer = taskDefinition.addContainer('XRayContainer', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
        memoryLimitMiB: 32,
        cpu: 32,
        essential: false,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'xray',
          logGroup,
        }),
        portMappings: [
          { containerPort: 2000, protocol: ecs.Protocol.UDP },
          { containerPort: 2000, protocol: ecs.Protocol.TCP }
        ],
        environment: {
          AWS_REGION: this.region
        },
        command: ['-o']
      });
    }

    // Cronタスク定義の作成
    const cronTaskDefinition = new ecs.FargateTaskDefinition(this, 'CronTaskDefinition', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole,
      executionRole: taskExecutionRole,
      family: generateResourceName('cron'),
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    // Cronコンテナの定義
    const cronContainer = cronTaskDefinition.addContainer('CronContainer', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs-cron',
        logGroup,
      }),
      environment: {
        ENVIRONMENT: props.environment,
        BCC_ADDRESS: props.bccAddress || '',
        SENTRY_DSN: props.sentryDsn || '',
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(database.secret!, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(database.secret!, 'port'),
        DB_NAME: ecs.Secret.fromSecretsManager(database.secret!, 'dbname'),
        DB_USER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
    });

    // ロードバランサーの作成
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSecurityGroup,
    });
    loadBalancer.setAttribute("routing.http.preserve_host_header.enabled", "true");

    // ブルー/グリーンデプロイメントのための2つのターゲットグループを作成
    // ブルーターゲットグループ（最初のデプロイ先）
    const blueTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(60),
      healthCheck: {
        path: '/health-check',
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    
    // グリーンターゲットグループ（新バージョンのデプロイ先）
    const greenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GreenTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(60),
      healthCheck: {
        path: '/health-check',
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // HTTPSリスナーの作成
    const httpsListener = loadBalancer.addListener('HttpsListener', {
      port: 443,
      open: true,
      certificates: [
        elbv2.ListenerCertificate.fromArn(props.certificateArn)
      ],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    });

    // 最初はブルーターゲットグループをHTTPSリスナーにアタッチ
    httpsListener.addTargetGroups('DefaultHttpsRoute', {
      targetGroups: [blueTargetGroup],
    });
    
    // テスト用のリスナーを作成（グリーン環境のテスト用）
    const testListener = loadBalancer.addListener('TestListener', {
      port: 8443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [
        elbv2.ListenerCertificate.fromArn(props.certificateArn)
      ],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: false,  // セキュリティのため限定的なアクセスのみ許可
    });

    testListener.connections.allowFrom(
      ec2.Peer.ipv4('153.142.38.216/32'),
      ec2.Port.tcp(8443),
      'Allow specific IP range'
    );
    
    // テストリスナーにはグリーンターゲットグループをアタッチ
    testListener.addTargetGroups('TestRoute', {
      targetGroups: [greenTargetGroup],
    });

    // HTTPからHTTPSへのリダイレクトリスナー
    loadBalancer.addRedirect({
      sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      sourcePort: 80,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      targetPort: 443,
    });

    // Fargateサービスの作成
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: props.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [ecsSecurityGroup],
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY,
      },
      capacityProviderStrategies: props.environment === 'staging' ? [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        }
      ] : undefined,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableECSManagedTags: true,
      enableExecuteCommand: true, // ECS Execを有効化
    });
    const cronService = new ecs.FargateService(this, 'CronService', {
      cluster,
      taskDefinition: cronTaskDefinition,
      desiredCount: 0,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [ecsSecurityGroup],
      capacityProviderStrategies: props.environment === 'staging' ? [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        }
      ] : undefined,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableECSManagedTags: true,
      enableExecuteCommand: true, // ECS Execを有効化
    });
    
    
    // 初期デプロイメントのためにブルーターゲットグループに登録
    service.attachToApplicationTargetGroup(blueTargetGroup);

    // オートスケーリングの設定
    const scaling = service.autoScaleTaskCount({
      minCapacity: props.desiredCount,
      maxCapacity: 10,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
    
    // データベース接続のセキュリティグループルールを更新
    database.connections.allowDefaultPortFrom(ecsSecurityGroup, 'Allow ECS to access RDS');

    // バケット名は必ず "aws-waf-logs-" で始める必要があります:contentReference[oaicite:0]{index=0}
    const wafLogsBucket = new Bucket(this, 'WafLogsBucket', {
      bucketName: `aws-waf-logs-dajp-${props.environment}`,      // 任意のサフィックスを付与
      encryption: BucketEncryption.S3_MANAGED,          // SSE-S3 暗号化
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,   // パブリックアクセスをブロック
      removalPolicy: RemovalPolicy.RETAIN,              // ログを保持したいので RETAIN
    });                       

    // WAF Web ACLの作成
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      name: generateResourceName('web-acl'),
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: generateResourceName('web-acl').replace(/[^a-zA-Z0-9]/g, '-'),
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              excludedRules: [
                { name: 'SizeRestrictions_BODY' }
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimit',
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimit',
            sampledRequestsEnabled: true,
          },
        },
        // // BOT対策
        // {
        //   name: 'AWSManagedRulesBotControlRuleSet',
        //   priority: 4,
        //   overrideAction: { none: {} },
        //   statement: {
        //     managedRuleGroupStatement: {
        //       vendorName: 'AWS',
        //       name: 'AWSManagedRulesBotControlRuleSet',
        //     },
        //   },
        //   visibilityConfig: {
        //     cloudWatchMetricsEnabled: true,
        //     metricName: 'AWSManagedRulesBotControlRuleSet',
        //     sampledRequestsEnabled: true,
        //   },
        // },
        // // 匿名IP対策
        // {
        //   name: 'AWSManagedRulesAnonymousIpList',
        //   priority: 5,
        //   overrideAction: { none: {} },
        //   statement: {
        //     managedRuleGroupStatement: {
        //       vendorName: 'AWS',
        //       name: 'AWSManagedRulesAnonymousIpList',
        //     },
        //   },
        //   visibilityConfig: {
        //     cloudWatchMetricsEnabled: true,
        //     metricName: 'AWSManagedRulesAnonymousIpList',
        //     sampledRequestsEnabled: true,
        //   },
        // },
      ],
    });

    const logConfig = new cdk.aws_wafv2.CfnLoggingConfiguration(
      this,
      "wafV2LoggingConfiguration",
      {
        logDestinationConfigs: [wafLogsBucket.bucketArn],
        resourceArn: webAcl.attrArn,
      }
    )

    // WAFとALBの関連付け
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // CodeBuildプロジェクトの作成
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: generateResourceName('build'),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        privileged: true,
      },
      environmentVariables: {
        ECR_REPOSITORY_URI: {
          value: ecrRepository.repositoryUri,
        },
        ECR_REPOSITORY_NAME: {
          value: ecrRepository.repositoryName,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPOSITORY_URI'
            ]
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Building the Docker image using Dockerfile.production...',
              `docker build -f Dockerfile.${props.environment} -t $ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION .`,
              'docker tag $ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION $ECR_REPOSITORY_URI:latest'
            ]
          },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing the Docker image...',
              'docker push $ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',
              'docker push $ECR_REPOSITORY_URI:latest',
              'echo "Creating appspec.yaml for CodeDeploy"',
              'bash -c \'cat > appspec.yaml <<EOF\nversion: 0.0\nResources:\n  - TargetService:\n      Type: AWS::ECS::Service\n      Properties:\n        TaskDefinition: <TASK_DEFINITION>\n        LoadBalancerInfo:\n          ContainerName: "AppContainer"\n          ContainerPort: 80\nEOF\'',
              'cat appspec.yaml',
              'echo "Creating imagedefinitions.json"',
              'printf \'[{"name":"AppContainer","imageUri":"%s:%s"}]\' "$ECR_REPOSITORY_URI" "$CODEBUILD_RESOLVED_SOURCE_VERSION" > imagedefinitions.json',
              'cat imagedefinitions.json',
              'echo "Creating taskdef.json"',
              'aws ecs describe-task-definition --task-definition $(aws ecs list-task-definitions --family-prefix "' + generateResourceName('app') + '" --sort DESC --max-items 1 | jq -r ".taskDefinitionArns[0]" | cut -d"/" -f2) --query "taskDefinition" | jq "del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)" > taskdef.json.tmp',
              'cat taskdef.json.tmp | jq --arg IMAGE "$ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION" \'.containerDefinitions[0].image = $IMAGE\' > taskdef.json',
              'cat taskdef.json',
            ],
          }
        },
        artifacts: {
          files: ['appspec.yaml', 'imagedefinitions.json', 'taskdef.json'],
        }
      })
    });
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecs:ListTaskDefinitions',
        'ecs:DescribeTaskDefinition'
      ],
      resources: ['*'],
    }));

    // ECRへのプッシュ権限を付与
    ecrRepository.grantPullPush(buildProject);

    // パイプラインの作成
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: generateResourceName('pipeline'),
      crossAccountKeys: false,
    });

    // ソースステージの追加
    const sourceOutput = new codepipeline.Artifact();
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub_Source',
      owner: props.githubRepoOwner,
      repo: props.githubRepoName,
      branch: props.environment === 'production' ? 'production' : 'staging',
      connectionArn: props.githubConnectionArn,
      output: sourceOutput,
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    // ビルドステージの追加
    const buildOutput = new codepipeline.Artifact();
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Build',
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    pipeline.addStage({
      stageName: 'Build',
      actions: [buildAction],
    });

    // CodeDeployのためのIAMロールを作成
    const codeDeployServiceRole = new iam.Role(this, 'CodeDeployServiceRole', {
      assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeDeployRoleForECS'),
      ],
    });
    
    // CodeDeployアプリケーションの作成
    const codeDeployApp = new codedeploy.EcsApplication(this, 'CodeDeployApplication', {
      applicationName: generateResourceName('app'),
    });
    
    // デプロイグループの作成
    const deploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'DeploymentGroup', {
      application: codeDeployApp,
      deploymentGroupName: generateResourceName('deployment-group'),
      service,
      blueGreenDeploymentConfig: {
        deploymentApprovalWaitTime: cdk.Duration.hours(1),
        terminationWaitTime: cdk.Duration.minutes(30),
        blueTargetGroup,
        greenTargetGroup,
        listener: httpsListener,
        testListener,
      },
      deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
      autoRollback: {
        failedDeployment: true,
        stoppedDeployment: true,
        deploymentInAlarm: false,
      },
      role: codeDeployServiceRole,
    });
    
    // デプロイステージの追加（CodeDeployを使用）
    const deployAction = new codepipeline_actions.CodeDeployEcsDeployAction({
      actionName: 'Deploy',
      deploymentGroup,
      taskDefinitionTemplateFile: buildOutput.atPath('taskdef.json'),
      appSpecTemplateFile: buildOutput.atPath('appspec.yaml')
    });
    
    pipeline.addStage({
      stageName: 'Deploy',
      actions: [deployAction],
    });

    // ============================
    // CronService 用 CodeBuild プロジェクト
    // ============================
    const cronBuildProject = new codebuild.PipelineProject(this, 'CronBuildProject', {
      projectName: generateResourceName('cron-build'),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        privileged: true,
      },
      environmentVariables: {
        ECR_REPOSITORY_URI: { value: cronEcrRepository.repositoryUri },
        ECR_REPOSITORY_NAME: { value: cronEcrRepository.repositoryName },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPOSITORY_URI',
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Building the Docker image for CronService...',
              'docker build -f Dockerfile.cron -t $ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION .',
              'docker tag $ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION $ECR_REPOSITORY_URI:latest',
            ],
          },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing the Docker image...',
              'docker push $ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',
              'docker push $ECR_REPOSITORY_URI:latest',
              'echo "Creating imagedefinitions.json for CronService"',
              'printf \'[{"name":"CronContainer","imageUri":"%s:%s"}]\' "$ECR_REPOSITORY_URI" "$CODEBUILD_RESOLVED_SOURCE_VERSION" > imagedefinitions.json',
              'cat imagedefinitions.json',
            ],
          },
        },
        artifacts: {
          files: ['imagedefinitions.json'],
        },
      }),
    });

    // CronBuildProject に ECR push 権限を付与
    cronEcrRepository.grantPullPush(cronBuildProject);

    // ============================
    // CronService 用パイプライン
    // ============================
    const cronPipeline = new codepipeline.Pipeline(this, 'CronPipeline', {
      pipelineName: generateResourceName('cron-pipeline'),
      crossAccountKeys: false,
    });

    // Source (cron branch)
    const cronSourceOutput = new codepipeline.Artifact('CronSourceOutput');
    const cronSourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub_Source',
      owner: props.githubRepoOwner,
      repo: props.githubRepoName,
      branch: `${props.environment}-cron`,
      connectionArn: props.githubConnectionArn,
      output: cronSourceOutput,
    });

    cronPipeline.addStage({
      stageName: 'Source',
      actions: [cronSourceAction],
    });

    // Build
    const cronBuildOutput = new codepipeline.Artifact('CronBuildOutput');
    const cronBuildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Build',
      project: cronBuildProject,
      input: cronSourceOutput,
      outputs: [cronBuildOutput],
    });

    cronPipeline.addStage({
      stageName: 'Build',
      actions: [cronBuildAction],
    });

    // Deploy (ECS Rolling Update)
    const cronDeployAction = new codepipeline_actions.EcsDeployAction({
      actionName: 'Deploy',
      service: cronService,
      imageFile: cronBuildOutput.atPath('imagedefinitions.json'),
    });

    cronPipeline.addStage({
      stageName: 'Deploy',
      actions: [cronDeployAction],
    });

    // ============================
    // Application Insights設定（本番環境のみ）
    // ============================
    
    if (props.environment === 'production') {
      // リソースグループの作成
    const resourceGroup = new resourcegroups.CfnGroup(this, 'ApplicationResourceGroup', {
      name: generateResourceName('app-resource-group'),
      description: `Resource group for dajp ${props.environment} environment`,
      resourceQuery: {
        type: 'TAG_FILTERS_1_0',
        query: {
          resourceTypeFilters: ['AWS::AllSupported'],
          tagFilters: [
            {
              key: 'Environment',
              values: [props.environment]
            },
            {
              key: 'Application',
              values: ['dajp']
            }
          ]
        }
      },
      tags: [
        {
          key: 'Environment',
          value: props.environment
        },
        {
          key: 'Application',
          value: 'dajp'
        }
      ]
    });

    // Application Insightsアプリケーションの作成
    const appInsightsApplication = new appinsights.CfnApplication(this, 'ApplicationInsights', {
      resourceGroupName: resourceGroup.name!,
      autoConfigurationEnabled: true,
      cweMonitorEnabled: true,
      opsCenterEnabled: false,
      tags: [
        {
          key: 'Environment',
          value: props.environment
        },
        {
          key: 'Application',
          value: 'dajp'
        }
      ]
    });

    // Application InsightsがリソースグループのARNに依存することを明示
    appInsightsApplication.addDependency(resourceGroup);

    // ECSクラスターでContainer Insightsを有効化（Application Insightsで使用）
    const cfnCluster = cluster.node.defaultChild as ecs.CfnCluster;
    cfnCluster.clusterSettings = [
      {
        name: 'containerInsights',
        value: 'enabled'
      }
    ];

      // リソースにタグを追加してApplication Insightsで監視対象として認識させる
      cdk.Tags.of(cluster).add('Environment', props.environment);
      cdk.Tags.of(cluster).add('Application', 'dajp');
      cdk.Tags.of(loadBalancer).add('Environment', props.environment);
      cdk.Tags.of(loadBalancer).add('Application', 'dajp');
      cdk.Tags.of(database).add('Environment', props.environment);
      cdk.Tags.of(database).add('Application', 'dajp');
      cdk.Tags.of(service).add('Environment', props.environment);
      cdk.Tags.of(service).add('Application', 'dajp');
      cdk.Tags.of(cronService).add('Environment', props.environment);
      cdk.Tags.of(cronService).add('Application', 'dajp');
    }

    // 出力
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: loadBalancer.loadBalancerDnsName,
      description: 'Load Balancer DNS Name',
      exportName: generateResourceName('loadbalancer-dns'),
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.dbInstanceEndpointAddress,
      description: 'Database Endpoint',
      exportName: generateResourceName('database-endpoint'),
    });

    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipeline.pipelineName,
      description: 'Pipeline Name',
      exportName: generateResourceName('pipeline-name'),
    });

    // Application Insightsの出力（本番環境のみ）
    if (props.environment === 'production') {
      new cdk.CfnOutput(this, 'ApplicationInsightsName', {
        value: generateResourceName('app-resource-group'),
        description: 'Application Insights Application Name',
        exportName: generateResourceName('app-insights-name'),
      });
    }
  }
} 
