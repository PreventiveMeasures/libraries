new_arch_enabled = ENV['RCT_NEW_ARCH_ENABLED'] == '1'

Pod::Spec.new do |s|
  s.name         = 'react-native-slider'
  s.version      = '4.5.5'
  s.summary      = 'React Native component used to select a single value from a range of values.'
  s.license      = 'MIT'
  s.authors      = 'react-native-community'
  s.homepage     = 'https://github.com/callstack/react-native-slider#readme'
  s.platforms    = { :ios => '9.0', :visionos => '1.0' }
  s.source       = { :git => 'https://github.com/callstack/react-native-slider.git', :tag => "v#{s.version}" }
  s.source_files = 'ios/**/*.{h,m,mm}'

  if new_arch_enabled
    s.subspec 'common' do |ss|
      ss.source_files        = 'common/cpp/**/*.{cpp,h}'
      ss.pod_target_xcconfig = { 'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/common/cpp"' }
    end
  end

  if defined?(install_modules_dependencies)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
    Pod::UI.puts 'Without React Native.'
  end
end
