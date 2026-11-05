// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Fixture",
    dependencies: [
        .package(id: "mona.LinkedList", exact: "1.2.0"),
        .package(url: "https://github.com/apple/swift-log.git", .exact("1.6.1")),
    ]
)
