import Foundation

struct DiagnosticsExporter {
    static func create(destination: URL, workRoot: URL, reportsRoot: URL, profileFolder: URL?, log: String, state: Data) throws {
        let fm = FileManager.default
        let temporary = fm.temporaryDirectory.appendingPathComponent("AutoEdit-Diagnostics-\(UUID().uuidString)")
        let folder = temporary.appendingPathComponent("AutoEdit-Diagnostics")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: temporary) }
        var inventory: [[String: String]] = []
        func copy(_ source: URL, category: String) {
            do {
                let attrs = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey])
                guard attrs.isRegularFile == true, attrs.isSymbolicLink != true else { return }
                let output = folder.appendingPathComponent(category).appendingPathComponent(source.lastPathComponent)
                try fm.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
                let data = try Data(contentsOf: source)
                let cleaned: Data
                if source.pathExtension == "jsonl" {
                    let lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
                    let sanitized = try lines.map { line -> String in
                        if let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) {
                            return String(decoding: try JSONSerialization.data(withJSONObject: redact(object), options: [.sortedKeys]), as: UTF8.self)
                        }
                        return redactText(String(line))
                    }.joined(separator: "\n")
                    cleaned = Data(sanitized.utf8)
                } else if let object = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) {
                    cleaned = try JSONSerialization.data(withJSONObject: redact(object), options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
                } else {
                    cleaned = Data(redactText(String(decoding: data, as: UTF8.self)).utf8)
                }
                try cleaned.write(to: output)
                inventory.append(["file": "\(category)/\(source.lastPathComponent)", "source": source.path,
                                  "modified": attrs.contentModificationDate.map { ISO8601DateFormatter().string(from: $0) } ?? "unknown"])
            } catch {
                inventory.append(["file": source.lastPathComponent, "error": error.localizedDescription])
            }
        }
        let workFiles = ["apply-run.json", "manifest.json", "recording_session_info.txt", "recording_session_info.parsed.json",
                         "recording_clip_metadata.json", "recording_metadata_before_relink.json", "edit_session_info.txt", "edit_session_info.parsed.json",
                         "edit_clip_metadata.json", "conform_plan.json", "command_plan.json", "apply_preflight.json",
                         "apply_execute.json", "apply_execute.json.journal.jsonl", "post_apply_session_info.txt", "post_apply_session_info.parsed.json"]
        for name in workFiles { copy(workRoot.appendingPathComponent(name), category: "work") }
        if let profileFolder {
            for name in ["recording-profile.json", "recording-session-info.txt", "recording-session-info.parsed.json", "recording-clip-metadata.json"] {
                copy(profileFolder.appendingPathComponent(name), category: "saved-profile")
            }
        }
        let reports = (try? fm.contentsOfDirectory(at: reportsRoot, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let recent = reports.filter { $0.lastPathComponent.hasPrefix("session-read-") && $0.pathExtension == "json" }
            .sorted { a, b in
                let dateA = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let dateB = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return dateA > dateB
            }.prefix(20)
        for report in recent { copy(report, category: "session-reads") }
        try Data(redactText(log).utf8).write(to: folder.appendingPathComponent("app-log.txt"))
        try state.write(to: folder.appendingPathComponent("app-state.json"))
        try JSONSerialization.data(withJSONObject: inventory, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent("inventory.json"))
        try """
        AutoEdit diagnostic export. Contains local paths, track/clip names, current unsaved configuration, saved profile snapshot, plans and logs.
        Audio files and PTX sessions are NOT included. PTSL session credentials are redacted. Nothing was sent over the network.
        Work files can be from different operations: compare inventory.json timestamps and app-state.json before diagnosis.
        Missing or unreadable files are recorded in inventory.json; this allows exporting diagnostics after a partial failure.
        """.write(to: folder.appendingPathComponent("README.txt"), atomically: true, encoding: .utf8)
        let archive = temporary.appendingPathComponent("diagnostics.zip")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-c", "-k", "--keepParent", folder.path, archive.path]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CocoaError(.fileWriteUnknown) }
        // Preserve an existing destination until a complete archive has been created.
        try Data(contentsOf: archive).write(to: destination, options: .atomic)
    }

    private static func redactText(_ text: String) -> String {
        text.replacingOccurrences(of: #"(?i)((?:\\)*"session_?id(?:\\)*"\s*:\s*(?:\\)*")[^"\\]*"#,
                                  with: "$1<redacted>", options: .regularExpression)
    }

    private static func redact(_ value: Any) -> Any {
        if let object = value as? [String: Any] {
            return object.mapValues { redact($0) }.reduce(into: [String: Any]()) { output, pair in
                output[pair.key] = pair.key.replacingOccurrences(of: "_", with: "").lowercased() == "sessionid" ? "<redacted>" : pair.value
            }
        }
        if let array = value as? [Any] { return array.map { redact($0) } }
        if let string = value as? String {
            if let nested = try? JSONSerialization.jsonObject(with: Data(string.utf8)),
               let data = try? JSONSerialization.data(withJSONObject: redact(nested), options: [.sortedKeys]),
               let encoded = String(data: data, encoding: .utf8) { return encoded }
            return redactText(string)
        }
        return value
    }
}
