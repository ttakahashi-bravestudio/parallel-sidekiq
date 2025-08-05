import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface InfraStackProps extends cdk.StackProps {
  environment: string;
  githubConnectionArn: string;
  githubRepoName: string;
  githubRepoOwner: string;
  cpu?: number;
  memoryLimitMiB?: number;
  desiredCount: number;
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    // リソース名生成用のメソッド
    const generateResourceName = (name: string): string => {
      return `parapp-${props.environment.substring(0, 3)}-${name}`.toLowerCase();
    };


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

    // Valkeyのセキュリティグループ
    let redisSecurityGroup = new ec2.SecurityGroup(this, 'ValkeySecurityGroup', {
      vpc,
      securityGroupName: generateResourceName('valkey-sg'),
      description: 'Security group for Valkey ElastiCache',
      allowAllOutbound: false,
    });

    // セキュリティグループのルール設定
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTPS traffic'
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Allow HTTPS traffic for blue-green'
    );

    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      'Allow traffic from ALB'
    );

    rdsSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow MySQL traffic from ECS'
    );

    // Valkey ElastiCacheの作成
    // サブネットグループの作成
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'ValkeySubnetGroup', {
      description: 'Subnet group for Valkey ElastiCache',
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
      cacheSubnetGroupName: generateResourceName('valkey-subnet-group'),
    });

    // Valkeyクラスターの作成
    const valkey_description = 'ValkeyElastiCache';
    let redis = new elasticache.CfnReplicationGroup(this, "ReplicationGroup", {
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
      securityGroups: [rdsSecurityGroup],
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

    // S3バケットの作成
    const s3Bucket = new s3.Bucket(this, 'AppBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // taskRoleにS3バケットへのアクセス権限を追加
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:*'],
        resources: [s3Bucket.bucketArn, `${s3Bucket.bucketArn}/*`],
      })
    );

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask','ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:DescribeTaskDefinition'],
        resources: ['*'],
        conditions: { 'ArnEquals': { 'ecs:cluster': cluster.clusterArn } },
      })
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [taskExecutionRole.roleArn, taskRole.roleArn],
      })
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:TagResource'],
        resources: ['*'],
      })
    );

    // ロググループの作成
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${generateResourceName('app')}`,
      retention: props.environment === 'staging' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_YEAR,
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
      portMappings: [{ containerPort: 3000, hostPort: 3000 }],
      environment: {
        ENVIRONMENT: props.environment,
        REDIS_HOST: redis ? redis.attrPrimaryEndPointAddress : '',
        REDIS_PORT: redis ? redis.attrPrimaryEndPointPort : '',
        REDIS_URL: redis ? `${redis.attrPrimaryEndPointAddress}:${redis.attrPrimaryEndPointPort}` : '',
        SECRET_KEY_BASE: "fb2f2639555c25cbb239abe1770c10eb"
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(database.secret!, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(database.secret!, 'port'),
        DB_NAME: ecs.Secret.fromSecretsManager(database.secret!, 'dbname'),
        DB_USER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
    });

    // sidekiqタスク定義の作成
    const sidekiqTaskDefinition = new ecs.FargateTaskDefinition(this, 'sidekiqTaskDefinition', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole,
      executionRole: taskExecutionRole,
      family: generateResourceName('sidekiq'),
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    // sidekiqコンテナの定義
    const sidekiqContainer = sidekiqTaskDefinition.addContainer('sidekiqContainer', {
      image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs-sidekiq',
        logGroup,
      }),
      environment: {
        ENVIRONMENT: props.environment,
        ECS_CLUSTER: cluster.clusterName,
        ECS_SIDEKIQ_TASK_DEFINITION: sidekiqTaskDefinition.family,
        ECS_SIDEKIQ_SUBNET_IDS: vpc.privateSubnets.map(subnet => subnet.subnetId).join(','),
        ECS_SIDEKIQ_SECURITY_GROUP_IDS: ecsSecurityGroup.securityGroupId,
        REDIS_HOST: redis ? redis.attrPrimaryEndPointAddress : '',
        REDIS_PORT: redis ? redis.attrPrimaryEndPointPort : '',
        REDIS_URL: redis ? `${redis.attrPrimaryEndPointAddress}:${redis.attrPrimaryEndPointPort}` : '',
        SECRET_KEY_BASE: "fb2f2639555c25cbb239abe1770c10eb"
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(database.secret!, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(database.secret!, 'port'),
        DB_NAME: ecs.Secret.fromSecretsManager(database.secret!, 'dbname'),
        DB_USER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
      command: ['bundle', 'exec', 'sidekiq', '-C', 'config/sidekiq.yml'],
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
        path: '/up',
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
        path: '/up',
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // HTTPSリスナーの作成
    const httpsListener = loadBalancer.addListener('HttpsListener', {
      port: 80,
      open: true,
    });

    // 最初はブルーターゲットグループをHTTPSリスナーにアタッチ
    httpsListener.addTargetGroups('DefaultHttpsRoute', {
      targetGroups: [blueTargetGroup],
    });
    
    // テスト用のリスナーを作成（グリーン環境のテスト用）
    const testListener = loadBalancer.addListener('TestListener', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
    });
    
    // テストリスナーにはグリーンターゲットグループをアタッチ
    testListener.addTargetGroups('TestRoute', {
      targetGroups: [greenTargetGroup],
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
    const sidekiqService = new ecs.FargateService(this, 'SidekiqService', {
      cluster,
      taskDefinition: sidekiqTaskDefinition,
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
              'echo Building the Docker image using Dockerfile...',
              `docker build -f Dockerfile -t $ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION .`,
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
              'bash -c \'cat > appspec.yaml <<EOF\nversion: 0.0\nResources:\n  - TargetService:\n      Type: AWS::ECS::Service\n      Properties:\n        TaskDefinition: <TASK_DEFINITION>\n        LoadBalancerInfo:\n          ContainerName: "AppContainer"\n          ContainerPort: 3000\nEOF\'',
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
              'docker build -f Dockerfile -t $ECR_REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION .',
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
              'printf \'[{"name":"sidekiqContainer","imageUri":"%s:%s"}]\' "$ECR_REPOSITORY_URI" "$CODEBUILD_RESOLVED_SOURCE_VERSION" > imagedefinitions.json',
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
      service: sidekiqService,
      imageFile: cronBuildOutput.atPath('imagedefinitions.json'),
    });

    cronPipeline.addStage({
      stageName: 'Deploy',
      actions: [cronDeployAction],
    });

    // 出力
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: loadBalancer.loadBalancerDnsName,
      description: 'Load Balancer DNS Name',
      exportName: generateResourceName('loadbalancer-dns'),
    });

    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipeline.pipelineName,
      description: 'Pipeline Name',
      exportName: generateResourceName('pipeline-name'),
    });
  }
} 
