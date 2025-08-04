class ClientReport < ApplicationRecord
    enum report_type: {
        xlsx: 0,
        pdf: 1
    }

    enum status: {
        pending: 0,
        processing: 1,
        completed: 2,
    }
end