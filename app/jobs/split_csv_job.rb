class SplitCsvJob < ApplicationJob
    queue_as :report
  
    def perform(csv_string, type, report_id)
      # CSV文字列をUTF-8として明示的に処理
      csv_string = csv_string.force_encoding('UTF-8')
      csv = CSV.parse(csv_string, headers: true)
      token = SecureRandom.uuid
      queue = QueueRouter.for_token(token)
      path  = "/tmp/reports/#{token}" # コンテナ内ローカル
  
      CsvProcessingStatus.create!(token:, total_count: csv.size, done_count: 0, queue_name: queue)
      ClientReport.find(report_id).update!(status: :processing, token:)
  
      csv.each do |row|
        # エンコーディング問題を回避するため、ハッシュをUTF-8で明示的に処理
        row_hash = row.to_h.transform_values do |value|
          value&.force_encoding('UTF-8')
        end
        
        # Sidekiq::Job を直接使っている前提: enqueue_to でキュー指定
        Sidekiq::Client.enqueue_to(queue, Report::ProcessCsvRowJob, row_hash, type, report_id, path, token)
      end
  
      # Finalize（ポーリング型）も専用キューへ
      at = Time.zone.now.to_f # すぐに開始、足りなければジョブ内でsleep再投入
      Sidekiq::Client.push(
        'class' => Report::FinalizeReportJob,
        'queue' => queue,
        'args'  => [path, type, report_id, token, 10, 43200, Time.zone.now.to_i],
        'at'    => at
      )
  
      if ENV["LOCAL_SAVE"].blank?
        # 専用ワーカー（そのキューだけを処理）を1タスク起動
        EcsTaskLauncher.start_once_for!(
          token: token,
          cluster: ENV["ECS_CLUSTER"],
          task_definition: ENV["ECS_SIDEKIQ_TASK_DEFINITION"],
          container_name: "sidekiqContainer",
          subnets: ENV["ECS_SIDEKIQ_SUBNET_IDS"].split(","),
          security_groups: ENV["ECS_SIDEKIQ_SECURITY_GROUP_IDS"].split(","),
          assign_public_ip: "DISABLED",
          env: {
            "TOKEN" => token,
            "QUEUE" => queue,
          },
          command: ["bundle", "exec", "sidekiq", "-q", queue, "-c", "10"],
          capacity_providers: nil, # デフォルトのFARGATEを使用
          tags: { "App" => "report", "Token" => token, "Env" => Rails.env }
        )
      end

    end
  end
  