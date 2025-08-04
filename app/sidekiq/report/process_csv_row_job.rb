class Report::ProcessCsvRowJob
  include Sidekiq::Job
  sidekiq_options queue: :report # 実際は enqueue_to で上書きされる

  def perform(row, type, report_id, path, token)
    FileUtils.mkdir_p(path)
    svc = ReportService.new(row['個別識別番号'], row['保険者名'], row['年度'])
    svc.generate_xlsx(path, row['個別識別番号'])
    svc.generate_pdf(path, row['個別識別番号']) if type == 'pdf'

    CsvProcessingStatus.where(token:).update_all("done_count = done_count + 1")
  end
end
