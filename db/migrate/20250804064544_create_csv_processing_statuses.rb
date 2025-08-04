class CreateCsvProcessingStatuses < ActiveRecord::Migration[8.0]
  def change
    create_table :csv_processing_statuses do |t|
      t.string  :token, null: false
      t.integer :total_count, null: false, default: 0
      t.integer :done_count,  null: false, default: 0
      t.string :queue_name
      t.datetime :finalized_at

      t.timestamps
    end

    add_index :csv_processing_statuses, :token, unique: true
  end
end
