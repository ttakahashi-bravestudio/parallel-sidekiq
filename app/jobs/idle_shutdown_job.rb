class IdleShutdownJob < ApplicationJob
  queue_as :default

  def perform(token)
    Rails.logger.info "Starting IdleShutdownJob for token: #{token}"
    
    begin
      status = CsvProcessingStatus.find_by(token: token)
      return unless status&.queue_name.present?

      # キューの残りジョブ数を再確認
      queue = Sidekiq::Queue.new(status.queue_name)
      remaining_jobs = queue.size

      if remaining_jobs == 0
        # ジョブが残っていない場合、Redisキューをクリア＆ECSタスクを停止
        clear_redis_queue_for_token(token, "IdleShutdownJob")
        
        if ENV["ECS_CLUSTER"].present?
          begin
            success = EcsTaskLauncher.stop_task_for!(token: token)
            if success
              Rails.logger.info "Successfully stopped ECS task via idle shutdown for token: #{token}"
            else
              Rails.logger.warn "Failed to stop ECS task via idle shutdown for token: #{token}"
            end
          rescue => e
            Rails.logger.error "Error during idle shutdown for token #{token}: #{e.message}"
          end
        end
      else
        # まだジョブが残っている場合、再スケジュール
        Rails.logger.info "Jobs still remaining (#{remaining_jobs}) for token #{token}, rescheduling..."
        self.class.set(wait: 30.seconds).perform_later(token)
      end
    rescue => e
      Rails.logger.error "IdleShutdownJob failed for token #{token}: #{e.message}"
    end
  end

  private

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