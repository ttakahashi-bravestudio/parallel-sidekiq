#!/bin/bash

# sidekiq_wrapper.sh（概略）
set -euo pipefail

QUEUE="${QUEUE:-default}"
CONCURRENCY="${CONCURRENCY:-10}"
IDLE="${SHUTDOWN_IDLE_SECONDS:-300}"

cd /rails
bundle exec sidekiq -q "$QUEUE" -c "$CONCURRENCY" &
SID=$!

# アイドル自己終了（任意）
ruby - <<'RUBY'
require "sidekiq"
idle = (ENV["SHUTDOWN_IDLE_SECONDS"] || "300").to_i
queue = ENV["QUEUE"] || "default"
last = Time.now
loop do
  sleep 5
  q = Sidekiq::Queue.new(queue).size
  last = Time.now if q > 0
  if Time.now - last > idle
    Sidekiq.logger.info("Idle > #{idle}s. Shutting down.")
    Process.kill("TERM", ENV["SID"].to_i) rescue nil
    break
  end
end
RUBY
wait $SID || true
