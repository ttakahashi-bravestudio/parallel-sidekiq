class SampleJob < ApplicationJob
  queue_as :default

  def perform(*args)
    p "sample job"
    # Do something later
  end
end
