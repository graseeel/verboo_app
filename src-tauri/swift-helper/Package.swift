// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ComputerUseHelper",
    targets: [
        .executableTarget(
            name: "computer-use-helper",
            path: ".",
            exclude: ["build.sh", "README.md"]
        )
    ]
)
