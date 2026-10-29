require "ripper"

syntax_only = false
while ARGV.first&.start_with?("-")
  option = ARGV.shift
  case option
  when "-c"
    syntax_only = true
  when "-I"
    $LOAD_PATH.unshift(*ARGV.shift.to_s.split(File::PATH_SEPARATOR))
  when /^-I(.+)/
    $LOAD_PATH.unshift(*Regexp.last_match(1).split(File::PATH_SEPARATOR))
  when "-e"
    code = ARGV.shift or abort "Missing Ruby expression"
    eval(code, TOPLEVEL_BINDING, "-e")
    exit
  when "--"
    break
  when "--version", "-v"
    puts RUBY_DESCRIPTION
    exit
  else
    abort "Unsupported bundled Ruby launcher option: #{option}"
  end
end
script = ARGV.shift or abort "Missing Ruby script"
if syntax_only
  abort "Syntax error in #{script}" unless Ripper.sexp(File.read(script))
  puts "Syntax OK"
else
  load File.expand_path(script)
end
