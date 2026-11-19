// Standalone smoke check: swiftc -parse-as-library Sources/AutoEditApp/DiagnosticsExporter.swift Tests/DiagnosticsExportCheck.swift -o /tmp/autoedit-diagnostics-check
import Foundation
@main struct DiagnosticsExportCheck {
    static func main() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? fm.removeItem(at: root) }
        let work = root.appendingPathComponent("work")
        let reports = root.appendingPathComponent("reports")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        try fm.createDirectory(at: reports, withIntermediateDirectories: true)
        try Data(#"{"session_id":"SECRET", "raw":{"response_body_json":"{\"session_id\":\"SECRET\"}"}}"#.utf8).write(to: reports.appendingPathComponent("session-read-test.json"))
        try Data("audio-not-for-export".utf8).write(to: work.appendingPathComponent("take.wav"))
        try Data("PRIVATE".utf8).write(to: work.appendingPathComponent(".ptsl-session.json"))
        try Data(#"{"song":"test"}"#.utf8).write(to: work.appendingPathComponent("manifest.json"))
        try Data(#"{"runID":"run-test","stage":"complete","uncertainAudio":"import","policyDigest":"approved-choice"}"#.utf8).write(to: work.appendingPathComponent("apply-run.json"))
        try Data(#"{"partial":true,"skipIssues":[{"code":"unverified-mapping","clipName":"SKIPPED_CLIP","timelineStartSamples":100}],"decisions":[{"approved":true}],"effectivePlan":{"clipGroups":[]}}"#.utf8).write(to: work.appendingPathComponent("apply_execute.json"))
        try Data((#"{"kind":"checkpoint","sessionId":"SECRET","results":[{"raw":{"response_body_json":"{\"session_id\":\"SECRET\"}"}}]}"# + "\n" + #"{"kind":"checkpoint","completedClips":2}"# + "\n").utf8).write(to: work.appendingPathComponent("apply_execute.json.journal.jsonl"))
        let zip = root.appendingPathComponent("result.zip")
        try DiagnosticsExporter.create(destination: zip, workRoot: work, reportsRoot: reports, profileFolder: nil,
            log: #"Error: {"session_id":"SECRET", "raw":"{\"session_id\":\"SECRET\"}"}"#, state: Data("{}".utf8))
        let unpack = root.appendingPathComponent("unpacked")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-x", "-k", zip.path, unpack.path]
        try process.run(); process.waitUntilExit()
        precondition(process.terminationStatus == 0)
        let files = fm.enumerator(at: unpack, includingPropertiesForKeys: [.isRegularFileKey])!
        var count = 0
        var foundPartialReport = false
        var foundRun = false
        var foundJournal = false
        for case let url as URL in files {
            guard (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { continue }
            precondition(url.pathExtension != "wav" && url.lastPathComponent != ".ptsl-session.json")
            let text = try String(contentsOf: url, encoding: .utf8)
            precondition(!text.contains("SECRET"))
            if url.lastPathComponent == "apply_execute.json" {
                precondition(text.contains("SKIPPED_CLIP") && text.contains("effectivePlan") && text.contains("approved"))
                foundPartialReport = true
            }
            if url.lastPathComponent == "apply_execute.json.journal.jsonl" {
                let entries = try text.split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) }
                precondition(entries.count == 2 && text.contains("completedClips"))
                foundJournal = true
            }
            if url.lastPathComponent == "apply-run.json" {
                precondition(text.contains("run-test") && text.contains("approved-choice") && text.contains("import"))
                foundRun = true
            }
            count += 1
        }
        precondition(count >= 8 && foundPartialReport && foundRun && foundJournal)
        // An existing output can be replaced, including after missing work inputs.
        try DiagnosticsExporter.create(destination: zip, workRoot: root.appendingPathComponent("absent"), reportsRoot: reports,
            profileFolder: nil, log: "failed", state: Data("{}".utf8))
        print("Diagnostics ZIP checks passed: round-trip, missing inputs, credential redaction, audio exclusion, replacement.")
    }
}
