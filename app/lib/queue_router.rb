require "digest/sha1"

module QueueRouter
  module_function

  def for_token(token)
    # Sidekiqキュー名に安全な短い識別子を使用
    "report-#{Digest::SHA1.hexdigest(token)[0,16]}"
  end
end