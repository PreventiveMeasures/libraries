// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Fixture",
    dependencies: [
        .package(url: "https://github.com/apple/swift-log.git", .exact("1.6.1")),
        .package(url: "https://github.com/Apple/Swift-Atomics.git", branch: "main"),
        .package(url: "https://github.com/apple/swift-numerics", revision: "0a5bc04095a675662cf24757cc0640aa2204253b"),
        .package(url: "https://github.com/apple/swift-collections", revision: "8d9834a"),
        .package(url: "https://github.com/apple/swift-distributed-tracing.git", .exact("1.1.2")),
    ]
)
