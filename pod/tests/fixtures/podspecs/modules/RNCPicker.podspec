Pod::Spec.new do |s|
  s.name      = 'RNCPicker'
  s.version   = '2.11.4'
  s.summary   = 'React Native Picker for iOS, Android, macOS, and Windows'
  s.license   = 'MIT'
  s.authors   = ''
  s.homepage  = 'https://github.com/react-native-picker/picker#readme'
  s.platforms = { :ios => '9.0', :osx => '10.14' }
  s.source    = { :git => 'https://github.com/react-native-picker/picker.git', :tag => "v#{s.version}" }

  unless ENV['RCT_NEW_ARCH_ENABLED'] == '1'
    s.ios.source_files = 'ios/**/*.{h,m,mm}'
    s.osx.source_files = 'macos/**/*.{h,m,mm}'
  else
    s.platforms    = { ios: '11.0', tvos: '11.0' }
    s.source_files = 'ios/**/*.{h,m,mm,cpp}'
    s.requires_arc = true
    install_modules_dependencies(s)
  end

  s.dependency 'React-Core'
end
