require 'sidekiq'
require 'sidekiq/web'

redis_erb = File.read('config/redis.yml')
yaml = ERB.new(redis_erb).result
redis_config = YAML.load(yaml, aliases: true)[Rails.env]
redis_config['db'] = redis_config['db']['sidekiq']

Sidekiq.configure_server do |config|
  # config.logger = Sidekiq::Logger.new("log/sidekiq.log")
  config.logger = Rails.logger
  config.logger.level = Logger::DEBUG
  config.redis = {
    url: "redis://#{redis_config['host']}/#{redis_config['db']}"
  }
  
  # デフォルトのリトライ回数を制限（ジョブ固有の設定で上書き可能）
  config.death_handlers << ->(job, ex) do
    Rails.logger.error "Job #{job['class']} died after #{job['retry_count']} retries"
    Rails.logger.error "Error: #{ex.class}: #{ex.message}"
  end
  
  # # 例外発生時のログ出力設定
  # config.error_handlers << ->(ex, context, config) do
  #   job_class = context[:job]&.dig('class') || 'Unknown'
  #   job_args = context[:job]&.dig('args') || []
    
  #   Rails.logger.error "=== Sidekiq Job Error ==="
  #   Rails.logger.error "Job Class: #{job_class}"
  #   Rails.logger.error "Job Arguments: #{job_args}"
  #   Rails.logger.error "Error: #{ex.class}: #{ex.message}"
  #   Rails.logger.error "Backtrace:"
  #   ex.backtrace.first(10).each { |line| Rails.logger.error "  #{line}" }
  #   Rails.logger.error "Context: #{context}"
  #   Rails.logger.error "========================"
  # end
end

Sidekiq.configure_client do |config|
  config.logger = Rails.logger
  config.logger.level = Logger::DEBUG
  config.redis = {
    url: "redis://#{redis_config['host']}/#{redis_config['db']}"
  }
end