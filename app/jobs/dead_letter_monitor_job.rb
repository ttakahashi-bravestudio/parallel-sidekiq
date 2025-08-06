class DeadLetterMonitorJob < ApplicationJob
  queue_as :default

  def perform
    Rails.logger.info "Starting DeadLetterMonitorJob"
    
    begin
      # デッドレターキューからジョブを取得
      dead_set = Sidekiq::DeadSet.new
      dead_jobs = dead_set.to_a
      
      dead_jobs.each do |job|
        job_class = job['class']
        job_args = job['args']
        
        # Report関連のジョブかチェック
        if job_class.include?('Report::')
          handle_report_dead_job(job, job_args)
        end
      end
    rescue => e
      Rails.logger.error "DeadLetterMonitorJob failed: #{e.message}"
      Rails.logger.error "Backtrace: #{e.backtrace.join("\n")}"
    end
  end

  private

  def handle_report_dead_job(job, job_args)
    # FinalizeReportJobの場合
    if job['class'] == 'Report::FinalizeReportJob'
      token = job_args[3] # tokenは4番目の引数
      report_id = job_args[2] # report_idは3番目の引数
      
      Rails.logger.warn "Found dead FinalizeReportJob for token: #{token}, report_id: #{report_id}"
      
      # ECSタスクを停止
      if ENV["ECS_CLUSTER"].present?
        stop_ecs_task_for_token(token)
      end
      
      # レポートステータスを失敗に更新
      update_report_status(report_id, :failed)
      
      # デッドレターキューから削除
      job.kill
      
    # ProcessCsvRowJobの場合
    elsif job['class'] == 'Report::ProcessCsvRowJob'
      token = job_args[4] # tokenは5番目の引数
      report_id = job_args[2] # report_idは3番目の引数
      
      Rails.logger.warn "Found dead ProcessCsvRowJob for token: #{token}, report_id: #{report_id}"
      
      # 一定数のデッドジョブが蓄積された場合のみECSタスクを停止
      dead_count = count_dead_jobs_for_token(token)
      if dead_count >= 5 # 5個以上のデッドジョブがある場合
        if ENV["ECS_CLUSTER"].present?
          stop_ecs_task_for_token(token)
        end
        update_report_status(report_id, :failed)
      end
    end
  end

  def stop_ecs_task_for_token(token)
    begin
      success = EcsTaskLauncher.stop_task_for!(token: token, reason: "Dead letter job detected")
      if success
        Rails.logger.info "Successfully stopped ECS task for dead job token: #{token}"
      else
        Rails.logger.warn "Failed to stop ECS task for dead job token: #{token}"
      end
    rescue => e
      Rails.logger.error "Error stopping ECS task for dead job token #{token}: #{e.message}"
    end
  end

  def update_report_status(report_id, status)
    begin
      report = ClientReport.find(report_id)
      report.update!(status: status) unless report.completed?
      Rails.logger.info "Updated report #{report_id} status to #{status}"
    rescue => e
      Rails.logger.error "Failed to update report #{report_id} status: #{e.message}"
    end
  end

  def count_dead_jobs_for_token(token)
    dead_set = Sidekiq::DeadSet.new
    dead_set.to_a.count { |job| job['args']&.include?(token) }
  end
end 