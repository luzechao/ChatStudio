require "fileutils"

destination = File.expand_path(ARGV.fetch(0))
prefix = ":/ruby/3.2.0/"
count = 0
EmbeddedScripting.fileNames.each do |name|
  next unless name.start_with?("#{prefix}gems/", "#{prefix}specifications/")
  relative = name.delete_prefix(prefix)
  target = File.expand_path(relative, destination)
  raise "Embedded gem path escapes destination: #{name}" unless target.start_with?("#{destination}/")
  FileUtils.mkdir_p(File.dirname(target))
  File.binwrite(target, File.read(name))
  count += 1
end
raise "No embedded gem files found" if count.zero?
puts "Extracted #{count} gem files from the official OpenStudio CLI."
