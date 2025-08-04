#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InfraStack } from '../lib/infra-stack';

const app = new cdk.App();

// 環境変数から設定を取得
const environment = process.env.ENVIRONMENT || 'staging';
const githubConnectionArn = process.env.GITHUB_CONNECTION_ARN;
const githubRepoName = process.env.GITHUB_REPO_NAME || 'dajp_php83';
const githubRepoOwner = process.env.GITHUB_REPO_OWNER || 'Bravestudio-Inc-JP';
const cpu = process.env.ECS_CPU ? parseInt(process.env.ECS_CPU, 10) : undefined;
const memoryLimitMiB = process.env.ECS_MEMORY ? parseInt(process.env.ECS_MEMORY, 10) : undefined;
const desiredCount = process.env.ECS_DESIRED_COUNT ? parseInt(process.env.ECS_DESIRED_COUNT, 10) : 0;

if (!githubConnectionArn) {
  throw new Error('GITHUB_CONNECTION_ARN environment variable is required');
}

if (!githubRepoName) {
  throw new Error('GITHUB_REPO_NAME environment variable is required');
}

// スタックの作成
new InfraStack(app, `dajp-${environment}-InfraStack`, {
  environment,
  githubConnectionArn,
  githubRepoName,
  githubRepoOwner,
  cpu,
  memoryLimitMiB,
  desiredCount,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  },
}); 