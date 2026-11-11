Pod::Spec.new do |s|
  s.name         = 'mattermost-hardware-keyboard'
  s.version      = '0.0.0'
  s.summary      = 'Hardware keyboard event capture replacing the project from react-native-hw-keyboard-event'
  s.homepage     = '#readme'
  s.license      = 'Apache 2.0'
  s.authors      = 'Mattermost, Inc.'
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => '.git', :tag => s.version }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'

  install_modules_dependencies(s)

  s.pod_target_xcconfig = {
    'USE_HEADERMAP' => 'YES',
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'BUILD_LIBRARY_FOR_DISTRIBUTION' => 'YES',
    'OTHER_CPLUSPLUSFLAGS' => ENV['RCT_NEW_ARCH_ENABLED'] == '1' ? '-DRCT_NEW_ARCH_ENABLED=1' : '',
    'OTHER_SWIFT_FLAGS' => '-no-verify-emitted-module-interface',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }
  s.user_target_xcconfig = { 'HEADER_SEARCH_PATHS' => ['"${PODS_CONFIGURATION_BUILD_DIR}/mattermost-hardware-keyboard/Swift Compatibility Header"'] }
end
