class IdleEcsTaskMonitorJob < ApplicationJob
  queue_as :default

  # アイドル判定の閾値（分）
  IDLE_THRESHOLD_MINUTES = 30

  def perform
    Rails.logger.info "Starting IdleEcsTaskMonitorJob"
    
    begin
      # 長時間アイドル状態のステータスを検索
      idle_threshold = IDLE_THRESHOLD_MINUTES.minutes.ago
      
      idle_statuses = CsvProcessingStatus.where.not(worker_started_at: nil)
                                        .where(finalized_at: nil)
                                        .where.not(worker_task_arn: nil)
                                        .where('worker_started_at < ?', idle_threshold)
      
      idle_statuses.each do |status|
        Rails.logger.warn "Found idle ECS task for token: #{status.token} (started at: #{status.worker_started_at})"
        
        # キューの残りジョブ数を確認
        if should_stop_idle_task?(status)
          stop_idle_ecs_task(status)
        end
      end
    rescue => e
      Rails.logger.error "IdleEcsTaskMonitorJob failed: #{e.message}"
      Rails.logger.error "Backtrace: #{e.backtrace.join("\n")}"
    end
  end

  private

  def should_stop_idle_task?(status)
    return false unless status.queue_name.present?
    
    begin
      # キューの残りジョブ数を確認
      queue = Sidekiq::Queue.new(status.queue_name)
      remaining_jobs = queue.size
      
      # ジョブが残っていない場合、または非常に少ない場合
      if remaining_jobs == 0
        Rails.logger.info "No remaining jobs for token: #{status.token}"
        return true
      elsif remaining_jobs <= 2 && is_task_stuck?(status)
        Rails.logger.info "Very few remaining jobs (#{remaining_jobs}) and task appears stuck for token: #{status.token}"
        return true
      end
      
      false
    rescue => e
      Rails.logger.error "Error checking queue for token #{status.token}: #{e.message}"
      # エラーの場合は安全のため停止
      true
    end
  end

  def is_task_stuck?(status)
    # 最後のジョブ処理から一定時間経過しているかチェック
    # この実装は簡易版。実際の運用ではより詳細な監視が必要
    last_activity_threshold = 10.minutes.ago
    
    # データベースの更新時刻をチェック（簡易的な実装）
    # 実際の運用では、ジョブの実行ログやメトリクスを使用することを推奨
    status.updated_at < last_activity_threshold
  end

  def stop_idle_ecs_task(status)
    begin
      if ENV["ECS_CLUSTER"].present?
        success = EcsTaskLauncher.stop_task_for!(token: status.token, reason: "Idle task timeout")
        
        if success
          Rails.logger.info "Successfully stopped idle ECS task for token: #{status.token}"
          
          # レポートステータスを失敗に更新
          update_report_status_for_token(status.token, :failed)
          
          # ステータスレコードをクリーンアップ
          cleanup_status_record(status)
        else
          Rails.logger.warn "Failed to stop idle ECS task for token: #{status.token}"
        end
      end
    rescue => e
      Rails.logger.error "Error stopping idle ECS task for token #{status.token}: #{e.message}"
    end
  end

  def update_report_status_for_token(token, status)
    begin
      report = ClientReport.find_by(token: token)
      if report
        report.update!(status: status) unless report.completed?
        Rails.logger.info "Updated report status to #{status} for idle task token: #{token}"
      end
    rescue => e
      Rails.logger.error "Failed to update report status for idle task token #{token}: #{e.message}"
    end
  end

  def cleanup_status_record(status)
    begin
      status.destroy
      Rails.logger.info "Cleaned up status record for idle task token: #{status.token}"
    rescue => e
      Rails.logger.error "Failed to cleanup status record for idle task token #{status.token}: #{e.message}"
    end
  end
end 