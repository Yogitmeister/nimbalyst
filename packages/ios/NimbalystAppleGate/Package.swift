// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "NimbalystAppleGate",
  platforms: [
    .iOS(.v18),
    .macOS(.v15),
  ],
  dependencies: [
    .package(name: "NimbalystNative", path: "../../../../sut/packages/ios/NimbalystNative"),
  ],
  targets: [
    .testTarget(
      name: "NIM367AppleGateTests",
      dependencies: [
        .product(name: "NimbalystNative", package: "NimbalystNative"),
      ],
      path: "Tests"
    ),
  ]
)
