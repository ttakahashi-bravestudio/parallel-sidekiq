# JSONライブラリのエンコーディング警告を回避するため、UTF-8エンコーディングを明示的に設定
require 'json'

# JSON.generateでUTF-8文字列を適切に処理するための設定
module JSON
  class << self
    alias_method :original_generate, :generate
    
    def generate(obj, opts = nil)
      # オブジェクトをUTF-8として明示的に処理
      if obj.is_a?(Hash)
        obj = obj.transform_values { |value| value&.force_encoding('UTF-8') if value.is_a?(String) }
      elsif obj.is_a?(Array)
        obj = obj.map { |item| item&.force_encoding('UTF-8') if item.is_a?(String) }
      end
      
      original_generate(obj, opts)
    end
  end
end 