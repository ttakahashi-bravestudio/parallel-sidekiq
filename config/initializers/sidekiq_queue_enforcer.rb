# frozen_string_literal: true
# =============================================================================
# Sidekiq Queue Enforcer
# -----------------------------------------------------------------------------
# 目的:
# - ジョブの引数中の `token` から専用キュー名を決定し、
#   *投入時(クライアント)* と *実行時(サーバ)* の両方で
#   「そのキューに載っているか」を強制検証します。
#
# 背景/効果:
# - tokenごとにキューを分離し、混線や並列衝突を避ける（token単位の隔離）。
# - 誤ったキュー指定を即座に検知して失敗させ、後工程の事故を防止。
# - queue名は `report-<SHA1(token)先頭16文字>`。生のtokenを露出しない。
#
# キュー名の決定:
# - QueueRouter.for_token(token) => "report-#{Digest::SHA1.hexdigest(token)[0,16]}"
#   ※ token が nil になる可能性があるなら hexdigest(token.to_s) へ変更を検討。
#   ※ 厳密性を上げたい場合は SHA256 + 長さ拡張（例: 20～24文字）も可。
#
# 対象ジョブと token の位置 (0始まり):
# - TARGETS は「ジョブクラス名 => tokenが入っているargsのインデックス」を持つハッシュ。
#   例)
#     "ProcessCsvRowJob"  => 4  # args: [row, type, report_id, path, token]
#     "FinalizeReportJob" => 3  # args: [path, type, report_id, token, ...]
# - 引数の順序を変更したら、必ず TARGETS も更新してください。
#
# 使い方（enqueue時の必須パターン）:
#   token = ...
#   ProcessCsvRowJob
#     .set(queue: QueueRouter.for_token(token))
#     .perform_async(row, type, report_id, path, token)
#
# ワーカー側（listenキューの例）:
#   bundle exec sidekiq -q report-<hash16>
#   ※ Fargate等で「tokenごとにワーカー(タスク)を起動」する設計と相性が良い。
#
# 失敗時の挙動:
# - クライアントミドルウェア（投入時）とサーバミドルウェア（実行直前）で
#   実キュー名と期待キュー名が異なると RuntimeError を raise します。
#
# 注意点:
# - token が取り出せない（nil/位置違い）と必ず失敗します。引数設計と TARGETS を同期させること。
# - ダイジェスト長を変える場合は、リスン側設定（-qやsidekiq.yml）も合わせて変更。
#
# テストTIPS:
# - Sidekiq::Testing.fake! で enqueued job の queue を検証。
# - ミドルウェアは #call にスタブjobを渡して単体テスト可能。
# =============================================================================

require "digest/sha1"
require_relative "../../app/lib/queue_router"

TARGETS = {
  "ProcessCsvRowJob"  => 4, # args: row, type, report_id, path, token
  "FinalizeReportJob" => 3  # args: path, type, report_id, token, ...
}

Sidekiq.configure_client do |config|
  config.client_middleware do |chain|
    chain.add Class.new {
      def call(worker_class, job, queue, _)
        if idx = TARGETS[worker_class]
          token = job["args"][idx]
          expected = QueueRouter.for_token(token)
          raise "Wrong queue=#{queue}, expected=#{expected} (#{worker_class})" if queue != expected
        end
        yield
      end
    }
  end
end

Sidekiq.configure_server do |config|
  config.server_middleware do |chain|
    chain.add Class.new {
      def call(worker, job, queue)
        if (idx = TARGETS[worker.class.name])
          token = job["args"][idx]
          expected = QueueRouter.for_token(token)
          raise "Wrong queue=#{queue}, expected=#{expected} (#{worker.class})" if queue != expected
        end
        yield
      end
    }
  end
end
