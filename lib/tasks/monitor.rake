namespace :monitor do
  desc "デッドレターキューを監視してECSタスクを停止"
  task dead_letter: :environment do
    Rails.logger.info "Running DeadLetterMonitorJob manually"
    DeadLetterMonitorJob.perform_now
  end

  desc "強制終了フラグを監視してECSタスクを停止"
  task force_shutdown: :environment do
    Rails.logger.info "Running ForceShutdownMonitorJob manually"
    ForceShutdownMonitorJob.perform_now
  end

  desc "アイドルECSタスクを監視して停止"
  task idle_tasks: :environment do
    Rails.logger.info "Running IdleEcsTaskMonitorJob manually"
    IdleEcsTaskMonitorJob.perform_now
  end

  desc "全ての監視ジョブを実行"
  task all: :environment do
    Rails.logger.info "Running all monitor jobs"
    DeadLetterMonitorJob.perform_now
    ForceShutdownMonitorJob.perform_now
    IdleEcsTaskMonitorJob.perform_now
  end

  desc "ECSタスクの状態を確認"
  task check_ecs_tasks: :environment do
    Rails.logger.info "Checking ECS task status"
    
    statuses = CsvProcessingStatus.where.not(worker_task_arn: nil)
                                 .where(finalized_at: nil)
    
    if statuses.empty?
      puts "No active ECS tasks found"
    else
      puts "Active ECS tasks:"
      statuses.each do |status|
        puts "  Token: #{status.token}"
        puts "  Task ARN: #{status.worker_task_arn}"
        puts "  Started at: #{status.worker_started_at}"
        puts "  Queue: #{status.queue_name}"
        puts "  Done/Total: #{status.done_count}/#{status.total_count}"
        puts "  Force shutdown: #{status.force_shutdown_at}"
        puts "---"
      end
    end
  end
end 