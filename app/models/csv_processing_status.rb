class CsvProcessingStatus < ApplicationRecord
    validates :token, presence: true, uniqueness: true

    def progress_ratio
      return 0 if total_count == 0
      (done_count.to_f / total_count).round(2)
    end
end
