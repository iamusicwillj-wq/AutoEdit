import Foundation

struct RunnerCommandResult {
    let command: String
    let arguments: [String]
    let exitCode: Int32
    let stdout: String
    let stderr: String

    var combinedOutput: String {
        [stdout, stderr].filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

final class RunnerProcessController: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var cancellationRequested = false

    func startOperation() {
        lock.withLock {
            process = nil
            cancellationRequested = false
        }
    }

    func attach(_ process: Process) {
        let shouldTerminate = lock.withLock {
            guard process.isRunning else { return false }
            self.process = process
            return cancellationRequested
        }
        if shouldTerminate && process.isRunning {
            process.terminate()
        }
    }

    func detach(_ process: Process) {
        lock.withLock {
            if self.process === process {
                self.process = nil
            }
        }
    }

    @discardableResult
    func cancel() -> Bool {
        let process = lock.withLock {
            cancellationRequested = true
            return self.process
        }
        if let process, process.isRunning {
            process.terminate()
        }
        return process != nil
    }

    var isCancellationRequested: Bool {
        lock.withLock { cancellationRequested }
    }

    func finishOperation() {
        lock.withLock { process = nil }
    }
}

enum RunnerBridgeError: Error, LocalizedError {
    case runnerNotFound
    case invalidRunnerRoot(String)
    case nodeNotFound
    case unknownScript(String)
    case commandFailed(RunnerCommandResult)
    case commandCancelled(RunnerCommandResult)

    var errorDescription: String? {
        switch self {
        case .runnerNotFound:
            return "Could not find tools/ptsl-runner. Set the runner path manually."
        case .invalidRunnerRoot(let path):
            return "Invalid ptsl-runner path: \(path)"
        case .nodeNotFound:
            return "Could not find Node.js. Checked the app bundle, AUTOEDIT_NODE_PATH, Homebrew, /usr/local, Volta, nvm, and the app PATH."
        case .unknownScript(let script):
            return "Unknown ptsl-runner script: \(script)"
        case .commandFailed(let result):
            return "Command failed: \(result.command) \(result.arguments.joined(separator: " "))"
        case .commandCancelled:
            return "Apply was cancelled. Changes already completed in Pro Tools were not undone."
        }
    }
}

struct RunnerBridge {
    var runnerRoot: URL

    static var applicationSupportRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AutoEdit V0.3.9", isDirectory: true)
    }

    static func locateRunnerRoot() throws -> URL {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("ptsl-runner"), isRunnerRoot(bundled) {
            return bundled
        }
        if let envPath = ProcessInfo.processInfo.environment["AUTOEDIT_RUNNER_ROOT"], !envPath.isEmpty {
            return try validateRunnerRoot(URL(fileURLWithPath: envPath))
        }

        var candidates: [URL] = []

        candidates.append(Bundle.main.bundleURL)
        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(resourceURL)
            candidates.append(resourceURL.appendingPathComponent("ptsl-runner", isDirectory: true))
        }
        candidates.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        if let executableURL = Bundle.main.executableURL {
            candidates.append(executableURL.deletingLastPathComponent())
        }

        for start in candidates {
            var cursor = start.standardizedFileURL
            for _ in 0..<12 {
                if isRunnerRoot(cursor) {
                    return cursor
                }

                let direct = cursor.appendingPathComponent("tools/ptsl-runner")
                if isRunnerRoot(direct) {
                    return direct
                }

                let sibling = cursor.deletingLastPathComponent().appendingPathComponent("tools/ptsl-runner")
                if isRunnerRoot(sibling) {
                    return sibling
                }

                let parent = cursor.deletingLastPathComponent()
                if parent.path == cursor.path {
                    break
                }
                cursor = parent
            }
        }

        throw RunnerBridgeError.runnerNotFound
    }

    static func validateRunnerRoot(_ url: URL) throws -> URL {
        let standardized = url.standardizedFileURL
        guard isRunnerRoot(standardized) else {
            throw RunnerBridgeError.invalidRunnerRoot(standardized.path)
        }
        return standardized
    }

    private static func isRunnerRoot(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent("package.json").path)
            && FileManager.default.fileExists(atPath: url.appendingPathComponent("src/ptslClient.js").path)
    }

    func runNpmScript(
        _ script: String,
        arguments: [String] = [],
        controller: RunnerProcessController? = nil
    ) async throws -> RunnerCommandResult {
        let nodeURL = try Self.locateNode()
        let entryPoint = try scriptEntryPoint(script)
        let result = try await run(
            command: nodeURL.path,
            arguments: [entryPoint.path] + arguments,
            controller: controller
        )
        if controller?.isCancellationRequested == true {
            throw RunnerBridgeError.commandCancelled(result)
        }
        if result.exitCode != 0 {
            throw RunnerBridgeError.commandFailed(result)
        }
        return result
    }

    private func scriptEntryPoint(_ script: String) throws -> URL {
        let relativePaths = [
            "conform:dry-run": "src/conformDryRun.js",
            "command-plan": "src/buildCommandPlan.js",
            "apply-plan": "src/applyCommandPlan.js",
            "export-clip-metadata": "src/exportClipMetadata.js",
            "export-session-info": "src/exportSessionInfo.js",
            "parse-session-info": "src/parseSessionInfo.js",
            "ptsl": "src/cli.js",
            "read-session": "src/readSession.js"
        ]
        guard let relativePath = relativePaths[script] else {
            throw RunnerBridgeError.unknownScript(script)
        }
        return runnerRoot.appendingPathComponent(relativePath)
    }

    private static func locateNode() throws -> URL {
        let fileManager = FileManager.default
        let environment = ProcessInfo.processInfo.environment
        var candidates: [String] = []

        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(resourceURL.appendingPathComponent("node/bin/node").path)
        }

        if let configured = environment["AUTOEDIT_NODE_PATH"], !configured.isEmpty {
            candidates.append(configured)
        }

        if let path = environment["PATH"] {
            candidates += path.split(separator: ":").map { "\($0)/node" }
        }

        candidates += [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".volta/bin/node").path
        ]

        let nvmRoot = fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
        if let versions = try? fileManager.contentsOfDirectory(
            at: nvmRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) {
            candidates += versions
                .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedDescending }
                .map { $0.appendingPathComponent("bin/node").path }
        }

        for candidate in candidates {
            let expanded = NSString(string: candidate).expandingTildeInPath
            if fileManager.isExecutableFile(atPath: expanded) {
                return URL(fileURLWithPath: expanded).resolvingSymlinksInPath()
            }
        }

        throw RunnerBridgeError.nodeNotFound
    }

    func run(
        command: String,
        arguments: [String],
        controller: RunnerProcessController? = nil
    ) async throws -> RunnerCommandResult {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: command)
            process.arguments = arguments
            process.currentDirectoryURL = runnerRoot
            var environment = ProcessInfo.processInfo.environment
            environment["AUTOEDIT_DATA_ROOT"] = Self.applicationSupportRoot
                .appendingPathComponent("Runner", isDirectory: true).path
            process.environment = environment

            let temporaryRoot = FileManager.default.temporaryDirectory
                .appendingPathComponent("AutoEdit-\(UUID().uuidString)", isDirectory: true)
            let stdoutURL = temporaryRoot.appendingPathComponent("stdout")
            let stderrURL = temporaryRoot.appendingPathComponent("stderr")

            do {
                try FileManager.default.createDirectory(
                    at: temporaryRoot,
                    withIntermediateDirectories: true
                )
                FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
                FileManager.default.createFile(atPath: stderrURL.path, contents: nil)
            } catch {
                continuation.resume(throwing: error)
                return
            }

            guard let stdoutHandle = try? FileHandle(forWritingTo: stdoutURL),
                  let stderrHandle = try? FileHandle(forWritingTo: stderrURL) else {
                try? FileManager.default.removeItem(at: temporaryRoot)
                continuation.resume(throwing: CocoaError(.fileWriteUnknown))
                return
            }

            process.standardOutput = stdoutHandle
            process.standardError = stderrHandle

            process.terminationHandler = { process in
                controller?.detach(process)
                try? stdoutHandle.close()
                try? stderrHandle.close()

                let stdoutData = (try? Data(contentsOf: stdoutURL)) ?? Data()
                let stderrData = (try? Data(contentsOf: stderrURL)) ?? Data()
                let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
                let stderr = String(data: stderrData, encoding: .utf8) ?? ""
                try? FileManager.default.removeItem(at: temporaryRoot)
                continuation.resume(returning: RunnerCommandResult(
                    command: command,
                    arguments: arguments,
                    exitCode: process.terminationStatus,
                    stdout: stdout,
                    stderr: stderr
                ))
            }

            do {
                try process.run()
                controller?.attach(process)
            } catch {
                try? stdoutHandle.close()
                try? stderrHandle.close()
                try? FileManager.default.removeItem(at: temporaryRoot)
                continuation.resume(throwing: error)
            }
        }
    }
}

func extractFirstJSONObject(from text: String) -> Data? {
    guard let start = text.firstIndex(of: "{") else {
        return nil
    }

    var depth = 0
    var inString = false
    var escaped = false

    var index = start
    while index < text.endIndex {
        let character = text[index]

        if escaped {
            escaped = false
        } else if character == "\\" {
            escaped = true
        } else if character == "\"" {
            inString.toggle()
        } else if !inString {
            if character == "{" {
                depth += 1
            } else if character == "}" {
                depth -= 1
                if depth == 0 {
                    let end = text.index(after: index)
                    return String(text[start..<end]).data(using: .utf8)
                }
            }
        }

        index = text.index(after: index)
    }

    return nil
}
