require 'zip'

class Report::FinalizeReportJob
    include Sidekiq::Job
    sidekiq_options queue: :report  # 実際は enqueue_to で上書きされる
  
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

        # # S3にアップロード
        # s3_client = Aws::S3::Client.new(region: ENV["AWS_REGION"])
        # response = s3_client.put_object(
        #   bucket: ENV["AWS_S3_BUCKET"],
        #   key: "reports/#{token}.zip",
        #   body: File.open(zip_path)
        # )

        # if response.successful?
        #   report.file = response.body
        #   report.count = Dir[File.join(path, '*')].count
        #   report.status = :completed
        #   report.save!
  
        report.file   = File.open(zip_path)
        report.count  = Dir[File.join(path, '*')].count
        report.status = :completed
        report.save!
  
        s.update!(finalized_at: Time.current)
      end
  
      # 片付け（ローカル ephemeral storage はタスク終了で破棄されるが念のため）
      FileUtils.rm_rf(path) rescue nil
      CsvProcessingStatus.find_by(token:)&.destroy
      
      Rails.logger.info "Completed FinalizeReportJob successfully"
    rescue => e
      Rails.logger.error "FinalizeReportJob failed: #{e.class}: #{e.message}"
      Rails.logger.error "Backtrace: #{e.backtrace.join("\n")}"
      raise e
    end
  end
  end
  