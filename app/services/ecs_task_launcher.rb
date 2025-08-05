# frozen_string_literal: true
#
# EcsTaskLauncher
# - 同一 token につき 1 タスクだけを RunTask する実装
# - 三重ガード: (A) DBアドバイザリロック + 行ロック, (B) ECS startedBy 重複検知, (C) 起動済み記録
#
# 事前条件:
# - CsvProcessingStatus に token(uniq), worker_started_at:datetime, worker_task_arn:string があること
# - 起動元ロールが以下を持つこと: ecs:RunTask / ecs:ListTasks / ecs:DescribeTasks / iam:PassRole
#
# 依存:
#   gem 'aws-sdk-ecs'
#
require "aws-sdk-ecs"
require "digest/sha1"
require "zlib"

class EcsTaskLauncher
  class << self
    # Public: token ごとに一度だけ起動する（推奨エントリ）
    #
    # @param token [String] バッチ識別子（ユニーク）
    # @param cluster [String] ECS クラスタ ARN/Name
    # @param task_definition [String] タスク定義 ARN/Name
    # @param container_name [String] 上書き対象のコンテナ名
    # @param subnets [Array<String>] サブネットID
    # @param security_groups [Array<String>] SG ID
    # @param assign_public_ip [String] "ENABLED"/"DISABLED"
    # @param env [Hash] コンテナ環境変数
    # @param command [Array<String>,nil] コンテナコマンド（省略時は上書きしない）
    # @param capacity_providers [Array<Hash>] [{name:, weight:}] or nil
    # @param tags [Hash] RunTask に付けるタグ
    # @param region [String] AWS リージョン（省略時は ENV["AWS_REGION"]）
    # @param max_concurrent [Integer,nil] （任意）同系タスクの同時実行上限
    # @param throttle_tag_key [String] （任意）同時実行カウント用タグキー
    # @param throttle_tag_value [String] （任意）同時実行カウント用タグ値
    #
    # @return [String] task_arn
    def start_once_for!(
      token:, 
      cluster: ENV["ECS_CLUSTER"], 
      task_definition: ENV["ECS_SIDEKIQ_TASK_DEFINITION"], 
      container_name: "sidekiqContainer", 
      subnets: ENV["ECS_SIDEKIQ_SUBNET_IDS"].split(","), 
      security_groups: ENV["ECS_SIDEKIQ_SECURITY_GROUP_IDS"].split(","),
      assign_public_ip: "DISABLED", env: {}, command: nil, capacity_providers: nil, tags: {},
      region: (ENV["AWS_REGION"] || "ap-northeast-1"),
      max_concurrent: nil, throttle_tag_key: "App", throttle_tag_value: "report"
    )
      with_token_lock(token, timeout: 10) do
        CsvProcessingStatus.transaction do
          s = CsvProcessingStatus.lock.find_by!(token: token)
          return s.worker_task_arn if s.worker_started_at.present?

          task_arn = start!(
            token: token,
            cluster: cluster,
            task_definition: task_definition,
            container_name: container_name,
            subnets: subnets,
            security_groups: security_groups,
            assign_public_ip: assign_public_ip,
            env: env,
            command: command,
            capacity_providers: capacity_providers,
            tags: tags,
            region: region,
            max_concurrent: max_concurrent,
            throttle_tag_key: throttle_tag_key,
            throttle_tag_value: throttle_tag_value
          )

          s.update!(worker_started_at: Time.current, worker_task_arn: task_arn)
          task_arn
        end
      end
    end

    # Public: ECSタスクを停止する
    #
    # @param token [String] バッチ識別子（ユニーク）
    # @param cluster [String] ECS クラスタ ARN/Name（省略時は ENV["ECS_CLUSTER"]）
    # @param region [String] AWS リージョン（省略時は ENV["AWS_REGION"]）
    # @param reason [String] 停止理由（省略時は "Report completed"）
    #
    # @return [Boolean] 停止成功時はtrue
    def stop_task_for!(token:, cluster: ENV["ECS_CLUSTER"], region: (ENV["AWS_REGION"] || "ap-northeast-1"), reason: "Report completed")
      status = CsvProcessingStatus.find_by(token: token)
      return false unless status&.worker_task_arn.present?

      ecs = Aws::ECS::Client.new(region: region)
      
      begin
        resp = ecs.stop_task(
          cluster: cluster,
          task: status.worker_task_arn,
          reason: reason
        )
        
        Rails.logger.info "Stopped ECS task: #{status.worker_task_arn} for token: #{token}"
        true
      rescue Aws::ECS::Errors::ServiceError => e
        Rails.logger.error "Failed to stop ECS task: #{e.message}"
        false
      end
    end

    # Public: 実体（RunTask + startedBy 二重検知 + リトライ + 同時実行上限オプション）
    #
    # @return [String] task_arn
    def start!(
      token:, cluster:, task_definition:, container_name:, subnets:, security_groups:,
      assign_public_ip: "DISABLED", env: {}, command: nil, capacity_providers: nil, tags: {},
      region: (ENV["AWS_REGION"] || "ap-northeast-1"),
      max_concurrent: nil, throttle_tag_key: "App", throttle_tag_value: "report"
    )
      ecs = Aws::ECS::Client.new(region: region)
      started_by = started_by_for(token)

      # 既存 PENDING/RUNNING を検知したら idempotent return
      existing = list_tasks_by_started_by(ecs, cluster, started_by)
      return existing.first if existing.any?

      attempts = 0
      max_attempts = 4

      begin
        attempts += 1

        # （任意）同時実行スロットル
        if max_concurrent
          running = count_running_tasks(ecs, cluster, task_definition, throttle_tag_key, throttle_tag_value)
          if running >= max_concurrent
            raise "ECS Task throttled: running=#{running} >= max_concurrent=#{max_concurrent}"
          end
        end

        run_params = {
          cluster: cluster,
          task_definition: task_definition,
          enable_ecs_managed_tags: true,
          started_by: started_by,
          network_configuration: {
            awsvpc_configuration: {
              subnets: subnets,
              security_groups: security_groups,
              assign_public_ip: assign_public_ip
            }
          },
          overrides: {
            container_overrides: [
              {
                name: container_name,
                environment: env.map { |k, v| { name: k.to_s, value: v.to_s } },
                command: command
              }.compact
            ]
          },
          tags: tags.map { |k, v| { key: k.to_s, value: v.to_s } }
        }

        if capacity_providers&.any?
          run_params[:capacity_provider_strategy] =
            capacity_providers.map { |h| { capacity_provider: h[:name], weight: (h[:weight] || 1) } }
        else
          run_params[:launch_type] = "FARGATE"
        end

        resp = ecs.run_task(run_params)

        if resp.failures&.any?
          reasons = resp.failures.map { |f| "#{f.arn || '-'}: #{f.reason}" }.join(", ")
          raise "ECS RunTask failures: #{reasons}"
        end

        task = resp.tasks&.first
        raise "ECS RunTask returned no task" unless task&.task_arn

        task.task_arn
      rescue Aws::ECS::Errors::ServiceError, RuntimeError => e
        raise e if attempts >= max_attempts
        sleep backoff_with_jitter(attempts)
        # リトライ前に二重起動を再確認（直前で他プロセスが起動した可能性あり）
        existing = list_tasks_by_started_by(ecs, cluster, started_by)
        return existing.first if existing.any?
        retry
      end
    end

    private

    # === DB アドバイザリロック（MySQL / PostgreSQL）===
    def with_token_lock(token, timeout:)
      cfg = ActiveRecord::Base.connection_db_config
      adapter = cfg.adapter
      lock_key = "report:launcher:#{token}"

      case adapter
      when /mysql/
        sql_get = ActiveRecord::Base.send(:sanitize_sql_array, ["SELECT GET_LOCK(?, ?)", lock_key, timeout])
        ActiveRecord::Base.connection.exec_query(sql_get)
        begin
          yield
        ensure
          sql_rel = ActiveRecord::Base.send(:sanitize_sql_array, ["DO RELEASE_LOCK(?)", lock_key])
          ActiveRecord::Base.connection.exec_query(sql_rel)
        end
      when /postgres/
        key_bigint = ((Zlib.crc32(lock_key) << 32) | Zlib.crc32(lock_key.reverse)) & 0xFFFFFFFFFFFFFFFF
        ActiveRecord::Base.connection.exec_query("SELECT pg_advisory_lock(#{key_bigint})")
        begin
          yield
        ensure
          ActiveRecord::Base.connection.exec_query("SELECT pg_advisory_unlock(#{key_bigint})")
        end
      else
        # その他: ロック無し（必要なら実装）
        yield
      end
    end

    def list_tasks_by_started_by(ecs, cluster, started_by)
      %w[PENDING RUNNING].flat_map do |status|
        ecs.list_tasks(cluster: cluster, desired_status: status, started_by: started_by).task_arns
      end
    end

    # family を推測し、RUNNING を Describe してタグで絞り込む
    def count_running_tasks(ecs, cluster, task_definition, tag_key, tag_value)
      family = task_definition.to_s.split(":").first
      arns = ecs.list_tasks(cluster: cluster, desired_status: "RUNNING", family: family).task_arns
      return 0 if arns.empty?
      desc = ecs.describe_tasks(cluster: cluster, tasks: arns, include: ["TAGS"])
      desc.tasks.count { |t| (t.tags || []).any? { |kv| kv.key == tag_key && kv.value == tag_value } }
    end

    # startedBy は最大36文字
    def started_by_for(token)
      base = "report-#{token}"
      return base if base.length <= 36
      "report-#{Digest::SHA1.hexdigest(token)[0, 28]}" # "report-" (7) + 28 = 35 (<=36)
    end

    def backoff_with_jitter(attempt)
      base = 0.5 * (2 ** (attempt - 1)) # 0.5, 1.0, 2.0, 4.0...
      jitter = rand * 0.2
      base + jitter
    end
  end
end
