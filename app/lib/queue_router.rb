require "digest/sha1"

module QueueRouter
  module_function

  def for_token(token)
    # Sidekiqキュー名に安全な短い識別子を使用
    "report-#{Digest::SHA1.hexdigest(token)[0,16]}"
  end

  # 特定のtokenに関連するキューをクリア
  def clear_queue_for_token(token, reason: "ECS task termination")
    return false unless token.present?

    queue_name = for_token(token)
    
    begin
      # Sidekiqキューのインスタンスを取得
      queue = Sidekiq::Queue.new(queue_name)
      initial_size = queue.size
      
      return true if initial_size == 0 # 既に空の場合は成功扱い
      
      Rails.logger.info "Clearing queue '#{queue_name}' for token: #{token} (#{initial_size} jobs, reason: #{reason})"
      
      # キューの全ジョブを削除
      cleared_count = 0
      queue.each do |job|
        # 該当tokenのジョブかダブルチェック
        if job_belongs_to_token?(job, token)
          job.delete
          cleared_count += 1
        end
      end
      
      final_size = Sidekiq::Queue.new(queue_name).size
      
      Rails.logger.info "Queue clear completed for token: #{token} - cleared #{cleared_count} jobs, remaining: #{final_size}"
      
      # 完全にクリアされたかチェック
      final_size == 0
      
    rescue => e
      Rails.logger.error "Failed to clear queue for token #{token}: #{e.class}: #{e.message}"
      Rails.logger.error "Backtrace: #{e.backtrace.first(5).join("\n")}"
      false
    end
  end

  # キューとスケジュールされたジョブの両方をクリア
  def clear_all_jobs_for_token(token, reason: "ECS task termination")
    return false unless token.present?

    success = true
    
    # 1. 通常のキューをクリア
    success &= clear_queue_for_token(token, reason: reason)
    
    # 2. スケジュールされたジョブ（scheduled set）をクリア
    success &= clear_scheduled_jobs_for_token(token, reason: reason)
    
    # 3. リトライキューからも削除
    success &= clear_retry_jobs_for_token(token, reason: reason)
    
    success
  end

  # スケジュールされたジョブをクリア
  def clear_scheduled_jobs_for_token(token, reason: "ECS task termination")
    return false unless token.present?

    begin
      scheduled_set = Sidekiq::ScheduledSet.new
      initial_size = scheduled_set.size
      cleared_count = 0
      
      scheduled_set.each do |job|
        if job_belongs_to_token?(job, token)
          job.delete
          cleared_count += 1
        end
      end
      
      Rails.logger.info "Cleared #{cleared_count} scheduled jobs for token: #{token} (reason: #{reason})" if cleared_count > 0
      true
      
    rescue => e
      Rails.logger.error "Failed to clear scheduled jobs for token #{token}: #{e.class}: #{e.message}"
      false
    end
  end

  # リトライキューからジョブをクリア
  def clear_retry_jobs_for_token(token, reason: "ECS task termination")
    return false unless token.present?

    begin
      retry_set = Sidekiq::RetrySet.new
      cleared_count = 0
      
      retry_set.each do |job|
        if job_belongs_to_token?(job, token)
          job.delete
          cleared_count += 1
        end
      end
      
      Rails.logger.info "Cleared #{cleared_count} retry jobs for token: #{token} (reason: #{reason})" if cleared_count > 0
      true
      
    rescue => e
      Rails.logger.error "Failed to clear retry jobs for token #{token}: #{e.class}: #{e.message}"
      false
    end
  end

  private

  # ジョブが指定されたtokenに属するかチェック
  def job_belongs_to_token?(job, token)
    return false unless job && token.present?

    job_class = job['class'] || job.klass
    job_args = job['args'] || job.args
    
    return false unless job_args.is_a?(Array)

    # TARGETS定義から該当ジョブのtoken位置を取得
    token_index = case job_class
                  when 'Report::ProcessCsvRowJob'
                    4 # args: [row, type, report_id, path, token]
                  when 'Report::FinalizeReportJob'
                    3 # args: [path, type, report_id, token, ...]
                  when 'IdleShutdownJob'
                    0 # args: [token]
                  else
                    # その他のジョブクラスの場合、引数全体をチェック
                    return job_args.include?(token)
                  end

    return false unless token_index && job_args.size > token_index
    
    job_args[token_index] == token
  end
end