# frozen_string_literal: true
require "json"

package = JSON.parse(File.read(File.expand_path("package.json", __dir__)))
version = package["version"]
flags = '-DRICH=1 ' + "-Wno-comma"

Pod::Spec.new do |spec|
  spec.name = "Rich"
  spec.version = version
  spec.summary = "  #{package['description']} for #{spec.name}  "
  spec.description = <<-DESC
    A longer description
      with an indented line.
  DESC
  spec.homepage = package["homepage"]
  spec.license = { :type => package["license"], :file => "LICENSE" }
  spec.authors = { "Rich Author" => "rich@example.com" }
  spec.source = { :http => "https://github.com/acme/rich/archive/refs/tags/v#{spec.version}.tar.gz",
                  :sha256 => "954a04e9468dee21259937b83a2b21c3985cc96f91ee0152a34a7f0f752093e8" }
  spec.platform = :ios, "13.4"
  spec.osx.deployment_target = "10.15"
  spec.requires_arc = true
  spec.module_name = 'RichKit'
  spec.header_dir = "rich"
  spec.frameworks = "UIKit", "AVFoundation"
  spec.weak_framework = 'CoreHaptics'
  spec.libraries = %w(z c++)
  spec.compiler_flags = flags
  spec.source_files = ["ios/**/*.{h,m,mm}", "common/*.h",]
  spec.exclude_files = "ios/Tests"
  spec.ios.source_files = "ios/only/*.m"
  spec.ios.dependency "IOSOnly", ">= 2.0", "< 3"
  spec.prepare_command = 'mv src double-conversion'
  spec.script_phase = { :name => "Gen", :script => "echo gen", :execution_position => :before_compile }
  spec.user_target_xcconfig = { "OTHER_LDFLAGS" => "-ObjC" }
  spec.default_subspec = "Core"
  spec.dependency("Plain", "~> 4.2")
  spec.dependency "Other"

  spec.subspec "Core" do |core|
    core.source_files = "core/**/*.{h,cpp}"
    core.private_header_files = "core/internal/*.h"
    core.dependency "#{spec.name}/Base"
  end

  spec.subspec "Base" do |base|
    base.source_files = "base/*.h"
    base.tvos.deployment_target = "14.0"
    base.subspec "Deep" do |deep|
      deep.resources = "deep/*.png"
    end
  end

  spec.test_spec do |t|
    t.source_files = "tests/*.m"
    t.requires_app_host = true
  end

  spec.app_spec "Demo" do |app|
    app.source_files = "demo/*.swift"
  end
end
