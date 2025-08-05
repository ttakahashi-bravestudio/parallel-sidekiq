class ApplicationJob < ActiveJob::Base
  # Automatically retry jobs that encountered a deadlock
  # retry_on ActiveRecord::Deadlocked

  # Most jobs are safe to ignore if the underlying records are no longer available
  # discard_on ActiveJob::DeserializationError
  
  # 例外発生時のログ出力
  rescue_from StandardError do |exception|
    Rails.logger.error "Job failed: #{self.class.name}"
    Rails.logger.error "Error: #{exception.class}: #{exception.message}"
    Rails.logger.error "Backtrace: #{exception.backtrace.join("\n")}"
    Rails.logger.error "Job arguments: #{arguments}"
    raise exception
  end
end
