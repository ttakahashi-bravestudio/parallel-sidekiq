require 'sidekiq'
require 'sidekiq/web'

redis_erb = File.read('config/redis.yml')
yaml = ERB.new(redis_erb).result
redis_config = YAML.load(yaml, aliases: true)[Rails.env]
redis_config['db'] = redis_config['db']['sidekiq']

Sidekiq.configure_server do |config|
  # config.logger = Sidekiq::Logger.new("log/sidekiq.log")
  config.logger = Rails.logger
  config.logger.level = Logger::INFO
  config.redis = {
    url: "redis://#{redis_config['host']}/#{redis_config['db']}"
  }
end

Sidekiq.configure_client do |config|
  config.logger = Rails.logger
  config.logger.level = Logger::INFO
  config.redis = {
    url: "redis://#{redis_config['host']}/#{redis_config['db']}"
  }
end