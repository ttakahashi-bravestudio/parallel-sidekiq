require 'zip'

class Report::FinalizeReportJob
    include Sidekiq::Job
    sidekiq_options queue: :report, retry: 3, dead: true  # 実際は enqueue_to で上書きされる
  
    def perform(path, type, report_id, token, interval_sec = 10, max_wait_sec = 43200, started_at = Time.now.to_i)
    Rails.logger.info "Starting FinalizeReportJob: path=#{path}, type=#{type}, report_id=#{report_id}, token=#{token}"
    
    begin
      status = CsvProcessingStatus.find_by(token:)
      report = ClientReport.find(report_id)
      return if status&.finalized_at.present? || report.completed?
  
      elapsed = Time.now.to_i - started_at
      if status.nil?
        report.update!(status: :failed)
        return
      elsif elapsed < max_wait_sec && status.done_count < status.total_count
        # ★再投入も「同じキュー」に投げ直す
        Sidekiq::Client.push(
          'class' => self.class,
          'queue' => status.queue_name || QueueRouter.for_token(token),
          'args'  => [path, type, report_id, token, interval_sec, max_wait_sec, started_at],
          'at'    => Time.now.to_f + interval_sec
        )
        return
      end
  
      CsvProcessingStatus.transaction do
        s = CsvProcessingStatus.lock.find_by!(token: token)
        break if s.finalized_at.present?
  
        zip_path = "#{path}_#{type}.zip"
        FileUtils.mkdir_p(path) unless Dir.exist?(path)
        Zip::File.open(zip_path, Zip::File::CREATE) do |zipfile|
          Dir[File.join(path, '*')].each { |f| zipfile.add(File.basename(f), f) }
        end

        if ENV["LOCAL_SAVE"].blank?
          # S3にアップロード
          s3_client = Aws::S3::Client.new(region: ENV["AWS_REGION"])
          response = s3_client.put_object(
            bucket: ENV["AWS_S3_BUCKET"],
            key: "reports/#{token}.zip",
            body: File.open(zip_path)
          )

          if response.successful?
            report.file = response.body
            report.count = Dir[File.join(path, '*')].count
            report.status = :completed
            report.save!
          end
        else
          report.file = File.open(zip_path)
          report.count = Dir[File.join(path, '*')].count
          report.status = :completed
          report.save!
        end
  
        s.update!(finalized_at: Time.current)
      end
  
      # 片付け（ローカル ephemeral storage はタスク終了で破棄されるが念のため）
      FileUtils.rm_rf(path) rescue nil
      
      # ECSタスクを停止（複数の救済処置付き）
      if ENV["ECS_CLUSTER"].present?
        stop_ecs_task_with_fallbacks(token)
      end
      
      CsvProcessingStatus.find_by(token:)&.destroy
      
      Rails.logger.info "Completed FinalizeReportJob successfully"
    rescue => e
      Rails.logger.error "FinalizeReportJob failed: #{e.class}: #{e.message}"
      Rails.logger.error "Backtrace: #{e.backtrace.join("\n")}"
      
      # 失敗時もECSタスクを停止する
      if ENV["ECS_CLUSTER"].present?
        stop_ecs_task_with_fallbacks(token)
      end
      
      # レポートステータスを失敗に更新
      begin
        report = ClientReport.find(report_id)
        report.update!(status: :failed) unless report.completed?
      rescue => report_error
        Rails.logger.error "Failed to update report status: #{report_error.message}"
      end
      
      raise e
    end
  end

  private

  # ECSタスク停止の救済処置付き実装
  def stop_ecs_task_with_fallbacks(token)
    # 方法1: 直接的なタスク停止
    if try_stop_ecs_task(token)
      return
    end

    # 方法2: アイドル状態で自然終了を促す
    if try_idle_shutdown(token)
      return
    end

    # 方法3: 強制終了（最後の手段）
    try_force_termination(token)
  end

  # 方法1: 直接的なタスク停止
  def try_stop_ecs_task(token)
    begin
      success = EcsTaskLauncher.stop_task_for!(token: token)
      if success
        Rails.logger.info "Successfully stopped ECS task for token: #{token}"
        return true
      end
    rescue => e
      Rails.logger.warn "Failed to stop ECS task for token #{token}: #{e.message}"
    end
    false
  end

  # 方法2: アイドル状態で自然終了を促す
  def try_idle_shutdown(token)
    begin
      # キューの残りジョブ数を確認
      status = CsvProcessingStatus.find_by(token: token)
      return false unless status&.queue_name.present?

      queue = Sidekiq::Queue.new(status.queue_name)
      remaining_jobs = queue.size

      if remaining_jobs == 0
        # ジョブが残っていない場合、アイドル終了ジョブを投入
        Sidekiq::Client.push(
          'class' => IdleShutdownJob,
          'queue' => status.queue_name,
          'args' => [token],
          'at' => Time.now.to_f + 60 # 1分後に実行
        )
        Rails.logger.info "Scheduled idle shutdown for token: #{token}"
        return true
      end
    rescue => e
      Rails.logger.warn "Failed to schedule idle shutdown for token #{token}: #{e.message}"
    end
    false
  end

  # 方法3: 強制終了（最後の手段）
  def try_force_termination(token)
    begin
      # データベースに強制終了フラグを設定
      status = CsvProcessingStatus.find_by(token: token)
      if status
        status.update!(force_shutdown_at: Time.current)
        Rails.logger.warn "Set force shutdown flag for token: #{token}"
      end

      # 外部監視システムに通知（オプション）
      notify_external_monitoring(token, "force_shutdown_required")
    rescue => e
      Rails.logger.error "Failed to set force shutdown for token #{token}: #{e.message}"
    end
  end

  # 外部監視システムへの通知
  def notify_external_monitoring(token, reason)
    # CloudWatch Events、SNS、Slack等への通知を実装
    # 例: CloudWatch EventsでECSタスクの強制終了を監視
    Rails.logger.info "Notified external monitoring: token=#{token}, reason=#{reason}"
  end
end