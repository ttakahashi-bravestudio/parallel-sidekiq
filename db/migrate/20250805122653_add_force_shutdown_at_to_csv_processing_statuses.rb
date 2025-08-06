class AddForceShutdownAtToCsvProcessingStatuses < ActiveRecord::Migration[8.0]
  def change
    add_column :csv_processing_statuses, :force_shutdown_at, :datetime
  end
end
