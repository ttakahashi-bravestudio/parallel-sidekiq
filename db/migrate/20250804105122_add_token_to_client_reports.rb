class AddTokenToClientReports < ActiveRecord::Migration[8.0]
  def change
    add_column :client_reports, :token, :string
  end
end
