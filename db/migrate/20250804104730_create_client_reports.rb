class CreateClientReports < ActiveRecord::Migration[8.0]
  def change
    create_table :client_reports, comment: "報告書" do |t|
      t.string :security_hash, comment: "改竄対策用ハッシュ"
      t.datetime :deleted_at, comment: "論理削除日時"
      t.integer :report_type, default: 0, null: false, comment: "ファイル形式"
      t.integer :count, default: 0, null: false, comment: "件数"
      t.string :file, comment: "ファイル"
      t.integer :status, default: 0, null: false, comment: "ステータス"

      t.timestamps
    end
  end
end
