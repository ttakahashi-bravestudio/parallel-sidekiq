class CsvProcessingController < ApplicationController
  def new
    @csv_processing_status = CsvProcessingStatus.new
  end

  def create
    if params[:csv_file].present?
      # CSVファイルをUTF-8として明示的に読み込み
      csv_content = params[:csv_file].read.force_encoding('UTF-8')
      csv_type = params[:csv_type] || 'default'
      report_id = SecureRandom.uuid # 実際のアプリケーションでは適切なIDを生成

      client_report = ClientReport.create!(
        report_type: csv_type,
        status: :pending
      )

      # SplitCsvJobをエンキュー
      SplitCsvJob.perform_later(csv_content, csv_type, client_report.id)

      redirect_to csv_processing_status_path, notice: 'CSV処理を開始しました。'
    else
      redirect_to new_csv_processing_path, alert: 'CSVファイルを選択してください。'
    end
  end

  def status
    @processing_statuses = CsvProcessingStatus.order(created_at: :desc).limit(10)
  end

  def show
    @processing_status = CsvProcessingStatus.find_by(token: params[:token])
    
    if @processing_status.nil?
      redirect_to csv_processing_status_path, alert: '処理状況が見つかりません。'
    end
  end
end 