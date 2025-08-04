# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.0].define(version: 2025_08_04_105122) do
  create_table "client_reports", force: :cascade do |t|
    t.string "security_hash"
    t.datetime "deleted_at"
    t.integer "report_type", default: 0, null: false
    t.integer "count", default: 0, null: false
    t.string "file"
    t.integer "status", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "token"
  end

  create_table "csv_processing_statuses", force: :cascade do |t|
    t.string "token", null: false
    t.integer "total_count", default: 0, null: false
    t.integer "done_count", default: 0, null: false
    t.string "queue_name"
    t.datetime "finalized_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["token"], name: "index_csv_processing_statuses_on_token", unique: true
  end
end
