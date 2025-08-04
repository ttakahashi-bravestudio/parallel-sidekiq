Rails.application.routes.draw do
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  require 'sidekiq/web'
  mount Sidekiq::Web => '/sidekiq'

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Render dynamic PWA files from app/views/pwa/* (remember to link manifest in application.html.erb)
  # get "manifest" => "rails/pwa#manifest", as: :pwa_manifest
  # get "service-worker" => "rails/pwa#service_worker", as: :pwa_service_worker

  # CSV処理関連のルート
  get 'csv_processing/new', to: 'csv_processing#new', as: :new_csv_processing
  post 'csv_processing', to: 'csv_processing#create', as: :csv_processing_index
  get 'csv_processing/status', to: 'csv_processing#status', as: :csv_processing_status
  get 'csv_processing/:token', to: 'csv_processing#show', as: :csv_processing_show

  # Defines the root path route ("/")
  root "csv_processing#new"
end
