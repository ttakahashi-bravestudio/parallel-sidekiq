class ForceShutdownMonitorJob < ApplicationJob
  queue_as :default

  def perform
    Rails.logger.info "Starting ForceShutdownMonitorJob"
    
    begin
      # force_shutdown_atが設定されているがECSタスクがまだ動いているものを検索
      force_shutdown_statuses = CsvProcessingStatus.where.not(force_shutdown_at: nil)
                                                   .where(finalized_at: nil)
                                                   .where.not(worker_task_arn: nil)
      
      force_shutdown_statuses.each do |status|
        Rails.logger.warn "Found force shutdown flag for token: #{status.token}"
        
        # Redisキューをクリア
        clear_redis_queue_for_token(status.token, "ForceShutdownMonitorJob")
        
        # ECSタスクを強制停止
        if ENV["ECS_CLUSTER"].present?
          force_stop_ecs_task(status)
        end
        
        # レポートステータスを失敗に更新
        update_report_status_for_token(status.token, :failed)
        
        # ステータスレコードをクリーンアップ
        cleanup_status_record(status)
      end
    rescue => e
      Rails.logger.error "ForceShutdownMonitorJob failed: #{e.message}"
      Rails.logger.error "Backtrace: #{e.backtrace.join("\n")}"
    end
  end

  private

  def force_stop_ecs_task(status)
    begin
      # 方法1: 通常の停止を試行
      success = EcsTaskLauncher.stop_task_for!(token: status.token, reason: "Force shutdown required")
      
      if success
        Rails.logger.info "Successfully force stopped ECS task for token: #{status.token}"
        return
      end
      
      # 方法2: AWS CLIを使用した強制停止（最後の手段）
      force_stop_via_aws_cli(status)
      
    rescue => e
      Rails.logger.error "Error force stopping ECS task for token #{status.token}: #{e.message}"
    end
  end

  def force_stop_via_aws_cli(status)
    begin
      cluster = ENV["ECS_CLUSTER"]
      region = ENV["AWS_REGION"] || "ap-northeast-1"
      
      # AWS CLIを使用してタスクを強制停止
      command = "aws ecs stop-task --cluster #{cluster} --task #{status.worker_task_arn} --reason 'Force shutdown via CLI' --region #{region}"
      
      result = system(command)
      
      if result
        Rails.logger.info "Successfully force stopped ECS task via CLI for token: #{status.token}"
      else
        Rails.logger.error "Failed to force stop ECS task via CLI for token: #{status.token}"
      end
    rescue => e
      Rails.logger.error "Error in force stop via CLI for token #{status.token}: #{e.message}"
    end
  end

  def update_report_status_for_token(token, status)
    begin
      report = ClientReport.find_by(token: token)
      if report
        report.update!(status: status) unless report.completed?
        Rails.logger.info "Updated report status to #{status} for token: #{token}"
      end
    rescue => e
      Rails.logger.error "Failed to update report status for token #{token}: #{e.message}"
    end
  end

  def cleanup_status_record(status)
    begin
      status.destroy
      Rails.logger.info "Cleaned up status record for token: #{status.token}"
    rescue => e
      Rails.logger.error "Failed to cleanup status record for token #{status.token}: #{e.message}"
    end
  end

  # Redisキューをクリアする処理
  def clear_redis_queue_for_token(token, reason)
    return unless token.present?

    begin
      success = QueueRouter.clear_all_jobs_for_token(token, reason: reason)
      
      if success
        Rails.logger.info "Successfully cleared Redis queue for token: #{token} (reason: #{reason})"
      else
        Rails.logger.warn "Failed to clear Redis queue for token: #{token} (reason: #{reason})"
      end
      
      success
    rescue => e
      Rails.logger.error "Error clearing Redis queue for token #{token}: #{e.class}: #{e.message}"
      false
    end
  end
end 