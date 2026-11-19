import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
import CryptoKit
import AVFoundation

enum AudioImportMode {
    case linkSource
    case convertToSessionFormat
}

@MainActor
final class AppModel: ObservableObject {
    @Published var language = UserDefaults.standard.string(forKey: "interfaceLanguage") ?? "system" {
        didSet { UserDefaults.standard.set(language, forKey: "interfaceLanguage") }
    }
    @Published var isPositionApprovalPresented = false
    @Published var pendingPositionIssues: [WorkflowIssue] = []
    @Published var isRuntimeApproval = false
    @Published var importUncertainAudio = false
    var selectedApprovalPreflight: ApplyReport.Preflight? {
        importUncertainAudio ? preflightReport?.preflight?.importAnyway : preflightReport?.preflight
    }
    var displayedApprovalIssues: [WorkflowIssue] {
        isRuntimeApproval ? pendingPositionIssues : (selectedApprovalPreflight?.approvalIssues ?? pendingPositionIssues)
    }
    @Published var resultIssues: [WorkflowIssue] = []
    private var approvalContinuation: CheckedContinuation<Bool, Never>?
    private var writeStarted = false
    private var locatedSourceBeforeApply = false
    private struct ApplyCancelled: Error {}

    func answerPositionApproval(_ approved: Bool) {
        isPositionApprovalPresented = false
        let continuation = approvalContinuation
        approvalContinuation = nil
        continuation?.resume(returning: approved)
    }

    func canLocateSource(_ issue: WorkflowIssue) -> Bool {
        issue.canLocateSource && (!isRunning || (isPositionApprovalPresented && !isRuntimeApproval && !writeStarted))
    }

    func locateSourceFile(_ issue: WorkflowIssue) {
        guard canLocateSource(issue), let oldPath = issue.sourcePath else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.audio]
        panel.title = L.text("Locate Source File")
        panel.message = L.text("Select the same original recording, with the same audio and source timing. This updates the loaded copy; save the Profile to keep the new path.") + "\n" + oldPath
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let audio = try AVAudioFile(forReading: url)
            let plan = try JSONSerialization.jsonObject(with: Data(contentsOf: commandPlanPath)) as? [String: Any]
            let groups = plan?["clipGroups"] as? [[String: Any]] ?? []
            let requiredChannels = groups.filter { $0["sourceFilePath"] as? String == oldPath }
                .compactMap { $0["channelCount"] as? Int }.max() ?? 0
            let original = try Data(contentsOf: recordingMetadataPath)
            let updated = try SourceRelink.metadata(original, oldPath: oldPath, newPath: url.path,
                sampleRate: audio.fileFormat.sampleRate, expectedSampleRate: Int(sampleRate) ?? 0,
                frames: audio.length, channels: Int(audio.fileFormat.channelCount), requiredChannels: requiredChannels)
            try original.write(to: requiredWorkRoot().appendingPathComponent("recording_metadata_before_relink.json"), options: .atomic)
            try updated.write(to: recordingMetadataPath, options: .atomic)
            for index in profileSourceFiles.indices where profileSourceFiles[index].absolutePath == oldPath {
                profileSourceFiles[index].absolutePath = url.path
                profileSourceFiles[index].filename = url.lastPathComponent
                profileSourceFiles[index].relativePath = url.lastPathComponent
                profileSourceFiles[index].wasOnlineWhenSaved = true
            }
            appendLog("Source relocated: \(oldPath) -> \(url.path)")
            conformPlan = nil
            commandPlan = nil
            preflightReport = nil
            resultIssues = []
            if isRunning {
                locatedSourceBeforeApply = true
                answerPositionApproval(false)
            } else {
                presentApplyResult(title: "Source File Located", message: "Run Apply again to rebuild and check the plan. Save the Recording Profile to keep the new path. Previously imported tracks are unchanged.")
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = L.text("Could Not Locate Source File")
            alert.informativeText = L.error(error.localizedDescription)
            alert.runModal()
        }
    }

    @Published var runnerRootPath = ""
    @Published var status = "Idle"
    @Published var logText = ""
    @Published var workflowError = ""
    @Published var plannedDestinationRenames: [String] = []
    @Published var isRunning = false
    @Published var isApplying = false
    @Published var isApplyResultPresented = false
    @Published var applyResultTitle = ""
    @Published var applyResultMessage = ""
    @Published var audioImportMode: AudioImportMode = .convertToSessionFormat

    @Published var currentSessionName = ""
    @Published var currentTrackCount: Int?
    @Published var currentTracks: [PTSLResponse.Body.Track] = []
    @Published var recordingSessionName = ""
    @Published var recordingTracks: [PTSLResponse.Body.Track] = []
    @Published var editSessionName = ""
    @Published var editTracks: [PTSLResponse.Body.Track] = []

    @Published var recordingSummary: SessionParseSummary?
    @Published var editSummary: SessionParseSummary?
    @Published var conformPlan: ConformPlan?
    @Published var commandPlan: CommandPlan?
    @Published var preflightReport: ApplyReport?
    @Published var applyReport: ApplyReport?
    @Published var postApplySummary: SessionParseSummary?

    @Published var projectName = "AutoEdit Project"
    @Published var sampleRate = "48000"
    @Published var cueId = ""
    @Published var expectedSessionName = "AutoEdit Edit Test"
    @Published var songName = ""
    @Published var recordingGroups: [RecordingGroup] = []
    @Published var selectedRecordingGroupID: UUID?
    @Published var editGroupSelections: [EditGroupSelection] = []
    @Published var availableProfiles: [RecordingProfileSummary] = []
    @Published var selectedProfileID: UUID?
    @Published var selectedProfileFolderPath = ""
    @Published var profileSourceFiles: [ProfileSourceFile] = []
    @Published var selectedEditTrackNames: Set<String> = []
    @Published var isRefreshingSelectedEditTracks = false
    private var loadedProfileID: UUID?
    private let applyProcessController = RunnerProcessController()

    var loadedProfileIDForUI: UUID? { loadedProfileID }
    var convertToSessionFormat: Bool { audioImportMode == .convertToSessionFormat }
    var linkSourceAudioFiles: Bool { audioImportMode == .linkSource }

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    init() {
        do {
            let runnerRoot = try RunnerBridge.locateRunnerRoot()
            runnerRootPath = runnerRoot.path
            try ensureWorkDirectory()
            try ensureProfileLibrary()
            refreshRecordingProfiles()
            appendLog("Found ptsl-runner: \(runnerRoot.path)")
        } catch {
            status = "Runner not found"
            appendLog(error.localizedDescription)
        }
    }

    var runnerRoot: URL? {
        try? RunnerBridge.validateRunnerRoot(URL(fileURLWithPath: runnerRootPath))
    }

    var workRoot: URL? {
        guard runnerRoot != nil else { return nil }
        return RunnerBridge.applicationSupportRoot.appendingPathComponent("app-work", isDirectory: true)
    }

    var profileLibraryRoot: URL {
        FileManager.default.urls(for: .musicDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AutoEdit Library", isDirectory: true)
    }

    var enabledEditGroupCount: Int {
        editGroupSelections.filter(\.isEnabled).count
    }

    var missingProfileSourceFileCount: Int {
        profileSourceFiles.filter { !FileManager.default.fileExists(atPath: $0.absolutePath) }.count
    }

    var recordingInfoPath: URL { requiredWorkRoot().appendingPathComponent("recording_session_info.txt") }
    var recordingMetadataPath: URL { requiredWorkRoot().appendingPathComponent("recording_clip_metadata.json") }
    var recordingParsedPath: URL { requiredWorkRoot().appendingPathComponent("recording_session_info.parsed.json") }
    var editInfoPath: URL { requiredWorkRoot().appendingPathComponent("edit_session_info.txt") }
    var editMetadataPath: URL { requiredWorkRoot().appendingPathComponent("edit_clip_metadata.json") }
    var editParsedPath: URL { requiredWorkRoot().appendingPathComponent("edit_session_info.parsed.json") }
    var manifestPath: URL { requiredWorkRoot().appendingPathComponent("manifest.json") }
    var conformPlanPath: URL { requiredWorkRoot().appendingPathComponent("conform_plan.json") }
    var commandPlanPath: URL { requiredWorkRoot().appendingPathComponent("command_plan.json") }
    var preflightPath: URL { requiredWorkRoot().appendingPathComponent("apply_preflight.json") }
    var applyPath: URL { requiredWorkRoot().appendingPathComponent("apply_execute.json") }
    var postApplyInfoPath: URL { requiredWorkRoot().appendingPathComponent("post_apply_session_info.txt") }
    var postApplyParsedPath: URL { requiredWorkRoot().appendingPathComponent("post_apply_session_info.parsed.json") }

    func setRunnerRootPath(_ path: String) {
        do {
            let root = try RunnerBridge.validateRunnerRoot(URL(fileURLWithPath: path))
            runnerRootPath = root.path
            try ensureWorkDirectory()
            status = "Runner ready"
            appendLog("Runner set to \(root.path)")
        } catch {
            status = "Invalid runner"
            appendLog(error.localizedDescription)
        }
    }

    func checkCurrentSession() {
        runTask("Check Current Session") {
            let snapshot = try await self.fetchCurrentSessionSnapshot()
            self.updateCurrentSession(with: snapshot)
            self.appendLog("Current session: \(self.currentSessionName), tracks: \(self.currentTracks.count)")
        }
    }

    func exportRecordingSession() {
        runTask("Export Recording Session") {
            let exported = try await self.readSession("export", paths: [self.recordingInfoPath, self.recordingMetadataPath, self.recordingParsedPath])
            let snapshot = (name: exported.body.session_name ?? "", tracks: exported.body.track_list ?? [])
            let shouldPreserveSelection = !self.recordingSessionName.isEmpty
                && self.recordingSessionName == snapshot.name
            self.updateCurrentSession(with: snapshot)
            self.recordingSessionName = snapshot.name
            if self.songName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !shouldPreserveSelection {
                self.songName = snapshot.name
            }
            self.recordingTracks = snapshot.tracks.filter(\.isAudio)
            if shouldPreserveSelection {
                self.reconcileRecordingGroups()
            } else {
                self.selectedProfileID = nil
                self.loadedProfileID = nil
                self.selectedProfileFolderPath = ""
                self.profileSourceFiles = []
                self.createDefaultRecordingGroup()
            }

            self.recordingSummary = exported.body.summary
            if let exportedSampleRate = self.recordingSummary?.sampleRate,
               exportedSampleRate > 0 {
                self.sampleRate = String(Int(exportedSampleRate))
            }
            if !shouldPreserveSelection {
                self.projectName = self.songName
            }
            self.appendLog(
                "Recording export complete: \(self.recordingSessionName), "
                    + "audio tracks: \(self.recordingTracks.count), groups: \(self.recordingGroups.count)"
            )
        }
    }

    func exportEditSession() {
        runTask("Export Edit Session") {
            let exported = try await self.readSession("export", paths: [self.editInfoPath, self.editMetadataPath, self.editParsedPath])
            let snapshot = (name: exported.body.session_name ?? "", tracks: exported.body.track_list ?? [])
            self.updateCurrentSession(with: snapshot)
            self.editSessionName = snapshot.name
            self.editTracks = snapshot.tracks.filter(\.isAudio)
            self.reconcileEditGroupSelections(resetSelections: true)
            self.expectedSessionName = snapshot.name

            self.editSummary = exported.body.summary
            self.appendLog(
                "Edit export complete: \(self.editSessionName), audio tracks: \(self.editTracks.count)"
            )
        }
    }

    func saveManifest() {
        runTask("Save Manifest") {
            try self.writeManifest()
            self.appendLog("Manifest saved: \(self.manifestPath.path)")
        }
    }

    func saveRecordingProfile() {
        runTask("Save Recording Profile") {
            try self.writeRecordingProfile()
            self.refreshRecordingProfiles()
            self.appendLog("Recording profile saved: \(self.selectedProfileFolderPath)")
        }
    }

    func exportDiagnostics() {
        guard !isRunning else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.zip]
        panel.nameFieldStringValue = "AutoEdit-Diagnostics-" + ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-") + ".zip"
        panel.message = L.text("Export logs, Session metadata and Profile settings for diagnosis. Includes file paths and track names; no audio files or PTX sessions.")
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        let log = logText
        let state: [String: Any] = [
            "language": language,
            "exportedAt": ISO8601DateFormatter().string(from: Date()),
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "development",
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "runnerPath": runnerRootPath, "status": status, "error": workflowError,
            "currentSession": currentSessionName, "recordingSession": recordingSessionName,
            "editSession": editSessionName, "expectedSession": expectedSessionName,
            "songName": songName, "sampleRate": sampleRate, "cueID": cueId,
            "profileFolder": selectedProfileFolderPath,
            "audioImportMode": convertToSessionFormat ? "convert" : "link",
            "groups": recordingGroups.map { group in [
                "id": group.id.uuidString, "name": group.name, "reference": group.recordingReferenceTrack,
                "tracks": group.targetTracks.map { ["source": $0.recordingSourceTrack, "destination": $0.editDestinationTrack] }
            ] as [String: Any] },
            "editSelections": editGroupSelections.map { ["groupID": $0.groupID.uuidString, "enabled": $0.isEnabled, "demoTrack": $0.editDemoTrack] as [String: Any] }
        ]
        let work = RunnerBridge.applicationSupportRoot.appendingPathComponent("app-work")
        let reports = RunnerBridge.applicationSupportRoot.appendingPathComponent("Runner/reports")
        let profile = selectedProfileFolderPath.isEmpty ? nil : URL(fileURLWithPath: selectedProfileFolderPath)
        runTask("Export Diagnostics") {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
            try await Task.detached {
                try DiagnosticsExporter.create(destination: destination, workRoot: work, reportsRoot: reports, profileFolder: profile, log: log, state: data)
            }.value
            self.appendLog("Diagnostics exported: \(destination.path)")
            NSWorkspace.shared.activateFileViewerSelecting([destination])
        }
    }

    func newRecordingProfile() {
        guard !isRunning else { return }
        clearLoadedRecordingProfile()
        projectName = "AutoEdit Project"
        sampleRate = "48000"
        cueId = ""
        conformPlan = nil
        commandPlan = nil
        preflightReport = nil
        applyReport = nil
        postApplySummary = nil
        plannedDestinationRenames = []
        workflowError = ""
        isApplyResultPresented = false
        applyResultTitle = ""
        applyResultMessage = ""
        status = "New Profile — Export a Recording Session to begin"
        appendLog("New Recording Profile started. Saved profiles are unchanged.")
    }

    func loadRecordingProfile(_ id: UUID) {
        runTask("Load Recording Profile") {
            try self.restoreRecordingProfile(id)
            self.appendLog("Recording profile loaded: \(self.songName)")
        }
    }

    func openProfileFolder() {
        guard !selectedProfileFolderPath.isEmpty else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: selectedProfileFolderPath))
    }

    func openProfileLibrary() {
        NSWorkspace.shared.open(profileLibraryRoot)
    }

    func refreshSelectedEditTracks() async {
        guard !isRefreshingSelectedEditTracks else { return }
        isRefreshingSelectedEditTracks = true
        defer { isRefreshingSelectedEditTracks = false }
        do {
            let response = try await readSession("selected")
            selectedEditTrackNames = Set((response.body.track_list ?? []).map(\.name))
            appendLog("Selected Edit Tracks refreshed: \(selectedEditTrackNames.count)")
        } catch {
            appendLog("Could not refresh selected Edit Tracks: \(error.localizedDescription)")
        }
    }

    func deleteRecordingProfile(_ id: UUID) {
        guard !isRunning else { return }
        guard let summary = availableProfiles.first(where: { $0.id == id }) else { return }
        do {
            try FileManager.default.removeItem(at: URL(fileURLWithPath: summary.folderPath))
            if loadedProfileID == id {
                clearLoadedRecordingProfile()
            } else if selectedProfileID == id {
                selectedProfileID = nil
            }
            refreshRecordingProfiles()
            appendLog("Recording profile deleted: \(summary.songName)")
        } catch {
            appendLog("Could not delete Recording Profile: \(error.localizedDescription)")
        }
    }

    private func prepareForApply() async throws {
            self.conformPlan = nil
            self.commandPlan = nil
            self.preflightReport = nil
            self.applyReport = nil
            self.postApplySummary = nil
            // A failed preparation must not be bundled with a previous run's
            // successful execution or post-apply snapshot.
            for file in [conformPlanPath, commandPlanPath, preflightPath, applyPath, URL(fileURLWithPath: applyPath.path + ".journal.jsonl"), postApplyInfoPath, postApplyParsedPath] {
                if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            }
            self.plannedDestinationRenames = []
            let bridge = try self.bridge()

            try self.checkApplyCancellation()
            self.appendLog("Step 1/3: Dry Run")
            let exported = try await self.readSession("export", paths: [self.editInfoPath, self.editMetadataPath, self.editParsedPath], controller: self.applyProcessController)
            try self.checkApplyCancellation()
            let snapshot = (name: exported.body.session_name ?? "", tracks: exported.body.track_list ?? [])
            guard snapshot.name == self.expectedSessionName else {
                throw self.validationError(
                    "Expected Pro Tools session \"\(self.expectedSessionName)\", got \"\(snapshot.name)\"."
                )
            }
            self.updateCurrentSession(with: snapshot)
            self.editSummary = exported.body.summary
            self.editTracks = snapshot.tracks.filter(\.isAudio)
            for selection in self.editGroupSelections where selection.isEnabled {
                guard self.editTracks.contains(where: { $0.name == selection.editDemoTrack }) else {
                    throw self.validationError("Selected reference track is no longer available: \(selection.editDemoTrack)")
                }
            }
            let existingTrackNames = Set(snapshot.tracks.map { $0.name.lowercased() })
            let renamedTracks = try self.writeManifest(avoidingExistingTrackNames: existingTrackNames)
            self.plannedDestinationRenames = renamedTracks.map {
                "\($0.original) -> \($0.resolved)"
            }
            for rename in renamedTracks {
                self.appendLog("Destination renamed: \(rename.original) -> \(rename.resolved)")
            }
            var result = try await bridge.runNpmScript("conform:dry-run", arguments: [
                "--manifest", self.manifestPath.path, "--partial-policy",
                "--edit-info", self.editInfoPath.path,
                "--edit-clip-metadata", self.editMetadataPath.path,
                "--recording-info", self.recordingInfoPath.path,
                "--recording-clip-metadata", self.recordingMetadataPath.path,
                "--output", self.conformPlanPath.path
            ], controller: self.applyProcessController)
            try self.checkApplyCancellation()
            self.appendResult(result)
            self.conformPlan = try self.decodeFile(ConformPlan.self, at: self.conformPlanPath)

            self.appendLog("Step 2/3: Build Command Plan")
            result = try await bridge.runNpmScript("command-plan", arguments: [
                "--conform-plan", self.conformPlanPath.path,
                "--output", self.commandPlanPath.path
            ], controller: self.applyProcessController)
            try self.checkApplyCancellation()
            self.appendResult(result)
            self.commandPlan = try self.decodeFile(CommandPlan.self, at: self.commandPlanPath)

            self.appendLog("Step 3/3: Preflight")
            result = try await bridge.runNpmScript("apply-plan", arguments: [
                "--command-plan", self.commandPlanPath.path,
                "--partial-policy", "--inspect",
                "--report", self.preflightPath.path
            ], controller: self.applyProcessController)
            try self.checkApplyCancellation()
            self.appendResult(result)
            self.preflightReport = try self.decodeFile(ApplyReport.self, at: self.preflightPath)
    }

    func applyToCurrentEditSession() {
        guard !isRunning else { return }
        isApplyResultPresented = false
        isApplying = true
        writeStarted = false
        resultIssues = []
        pendingPositionIssues = []
        isRuntimeApproval = false
        importUncertainAudio = false
        applyProcessController.startOperation()
        runTask("Apply To Edit Session") {
            let runID = UUID().uuidString
            let runRecord = self.requiredWorkRoot().appendingPathComponent("apply-run.json")
            var runDetails: [String: Any] = ["runID": runID, "startedAt": ISO8601DateFormatter().string(from: Date()), "stage": "preparing"]
            func saveRun() throws {
                try JSONSerialization.data(withJSONObject: runDetails, options: [.sortedKeys, .prettyPrinted]).write(to: runRecord, options: .atomic)
            }
            defer {
                if runDetails["stage"] as? String != "complete" {
                    runDetails["lastStage"] = runDetails["stage"]
                    runDetails["stage"] = "incomplete"
                    runDetails["finishedAt"] = ISO8601DateFormatter().string(from: Date())
                    try? saveRun()
                }
                self.isApplying = false
                self.applyProcessController.finishOperation()
            }
            try saveRun()
            self.status = "Checking…"
            try await self.prepareForApply()
            guard var preflight = self.preflightReport?.preflight else { throw self.validationError("No preflight report was returned.") }
            if !(preflight.fatalIssues ?? []).isEmpty && preflight.importAnyway == nil {
                self.resultIssues = (preflight.fatalIssues ?? []) + (preflight.skipIssues ?? [])
                throw self.validationError("Check Failed")
            }
            self.resultIssues = preflight.reviewIssues ?? []
            var approvalArguments: [String] = []
            if preflight.needsSkipApproval == true || preflight.importAnyway != nil {
                self.importUncertainAudio = !(preflight.fatalIssues ?? []).isEmpty && preflight.importAnyway != nil
                self.pendingPositionIssues = preflight.skipIssues ?? []
                let fingerprint = try self.applyInputFingerprint()
                let planData = try Data(contentsOf: self.commandPlanPath)
                let digest = SHA256.hash(data: planData).map { String(format: "%02x", $0) }.joined()
                self.status = "Review Issues — Approval Required"
                let approved = await withCheckedContinuation { continuation in
                    self.approvalContinuation = continuation
                    self.isPositionApprovalPresented = true
                }
                guard approved else { throw ApplyCancelled() }
                guard let chosen = self.selectedApprovalPreflight, (chosen.fatalIssues ?? []).isEmpty else {
                    throw self.validationError("Check Failed")
                }
                preflight = chosen
                try self.checkApplyCancellation()
                guard fingerprint == (try self.applyInputFingerprint()) else {
                    throw self.validationError("Configuration changed. Run Apply again.")
                }
                let snapshot = try await self.fetchCurrentSessionSnapshot(controller: self.applyProcessController)
                guard snapshot.name == self.expectedSessionName else { throw self.validationError("Current Session changed. Run Apply again.") }
                // Re-read edit content after the confirmation pause. No timeline writes.
                let checkInfo = self.requiredWorkRoot().appendingPathComponent("approval-session-check.txt")
                try await self.exportSessionInfo(to: checkInfo, controller: self.applyProcessController)
                let parsed = self.requiredWorkRoot().appendingPathComponent("approval-session-check.json")
                _ = try await self.parseSessionInfo(input: checkInfo, output: parsed, controller: self.applyProcessController)
                let before = try JSONSerialization.jsonObject(with: Data(contentsOf: self.editParsedPath)) as? [String: Any]
                let after = try JSONSerialization.jsonObject(with: Data(contentsOf: parsed)) as? [String: Any]
                // Ignore changing export metadata; compare track EDL and source lists.
                for key in ["tracks", "onlineClips", "onlineFiles"] {
                    let a = try JSONSerialization.data(withJSONObject: before?[key] ?? [], options: .sortedKeys)
                    let b = try JSONSerialization.data(withJSONObject: after?[key] ?? [], options: .sortedKeys)
                    guard a == b else { throw self.validationError("Edit Session changed. Read the Edit Session and run Apply again.") }
                }
                approvalArguments = ["--approved-plan-sha256", digest]
                self.resultIssues = (preflight.skipIssues ?? []) + (preflight.reviewIssues ?? [])
            } else if preflight.okToExecute != true {
                self.resultIssues = preflight.blockers ?? []
                throw self.validationError("Check Failed")
            }
            guard let policyDigest = preflight.policyDigest else { throw self.validationError("No preflight report was returned.") }
            approvalArguments += ["--approved-policy-sha256", policyDigest]
            approvalArguments += ["--uncertain-audio", preflight.uncertainAudio ?? "skip"]
            runDetails["stage"] = "executing"
            runDetails["uncertainAudio"] = preflight.uncertainAudio ?? "skip"
            runDetails["policyDigest"] = policyDigest
            try saveRun()
            try self.checkApplyCancellation()
            try await self.ensurePTSLConnection(controller: self.applyProcessController)
            try self.checkApplyCancellation()
            self.status = "Applying…"
            let bridge = try self.bridge()
            let approvalDirectory = self.requiredWorkRoot().appendingPathComponent("approvals-" + runID)
            try FileManager.default.createDirectory(at: approvalDirectory, withIntermediateDirectories: true)
            let monitor = Task { await self.monitorRuntimeApprovals(directory: approvalDirectory, runID: runID) }
            defer {
                monitor.cancel()
                self.answerPositionApproval(false)
                self.isRuntimeApproval = false
            }
            try? FileManager.default.removeItem(at: self.applyPath)
            self.writeStarted = true
            let result = try await bridge.runNpmScript("apply-plan", arguments: [
                "--command-plan", self.commandPlanPath.path,
                "--execute", "--partial-policy",
                "--approval-directory", approvalDirectory.path, "--run-id", runID,
                "--expected-session", self.expectedSessionName,
                "--audio-operation", self.audioImportMode == .convertToSessionFormat
                    ? "AOperations_ConvertAudio"
                    : "AOperations_AddAudio",
                "--report", self.applyPath.path
            ] + approvalArguments, controller: self.applyProcessController)
            self.appendResult(result)
            self.applyReport = try self.decodeFile(ApplyReport.self, at: self.applyPath)
            self.resultIssues = (self.applyReport?.skipIssues ?? []) + (self.applyReport?.reviewIssues ?? [])

            try await self.exportSessionInfo(
                to: self.postApplyInfoPath,
                controller: self.applyProcessController
            )
            self.postApplySummary = try await self.parseSessionInfo(
                input: self.postApplyInfoPath,
                output: self.postApplyParsedPath,
                controller: self.applyProcessController
            )
            self.appendLog("Post-apply verification exported: \(self.postApplyInfoPath.path)")
            runDetails["stage"] = "complete"
            runDetails["completedAt"] = ISO8601DateFormatter().string(from: Date())
            try saveRun()
            self.presentApplyResult(
                title: self.applyReport?.partial == true ? "Apply Partially Complete" : (self.resultIssues.isEmpty ? "Apply Complete" : "Apply Complete — Review Needed"),
                message: self.applyReport?.partial == true
                    ? "Applied \(self.applyReport?.completedClips ?? 0) clip groups. Some items were skipped. Review the list below."
                    : "Recorded Tracks were successfully applied to \"\(self.expectedSessionName)\"."
            )
        }
    }

    private func monitorRuntimeApprovals(directory: URL, runID: String) async {
        var handled = Set<String>()
        while !Task.isCancelled {
            if let data = try? Data(contentsOf: directory.appendingPathComponent("request.json")),
               let request = try? decoder.decode(RuntimeApprovalRequest.self, from: data),
               request.runID == runID, handled.insert(request.token).inserted {
                let fingerprint = try? applyInputFingerprint()
                isRuntimeApproval = true
                pendingPositionIssues = [request.issue]
                status = "Skip Issues — Approval Required"
                let approved = await withCheckedContinuation { continuation in
                    approvalContinuation = continuation
                    isPositionApprovalPresented = true
                }
                guard !Task.isCancelled else { return }
                do {
                    let unchanged = fingerprint != nil && fingerprint == (try? applyInputFingerprint())
                    let reply: [String: Any] = ["runID": runID, "token": request.token, "approved": approved && unchanged]
                    if !unchanged { appendLog("Configuration changed. Run Apply again.") }
                    try JSONSerialization.data(withJSONObject: reply).write(to: directory.appendingPathComponent("response.json"), options: .atomic)
                    status = approved ? "Applying…" : "Cancelling Apply"
                } catch {
                    appendLog("Could not deliver approval: \(error.localizedDescription)")
                    applyProcessController.cancel()
                    return
                }
            }
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
        }
    }

    private func checkApplyCancellation() throws {
        if applyProcessController.isCancellationRequested { throw ApplyCancelled() }
    }

    private func applyInputFingerprint() throws -> Data {
        var data = try encoder.encode(recordingGroups)
        for value in [songName, projectName, sampleRate, cueId, expectedSessionName, String(convertToSessionFormat), selectedProfileFolderPath] {
            data.append(Data(value.utf8)); data.append(0)
        }
        for selection in editGroupSelections {
            data.append(Data("\(selection.groupID)|\(selection.isEnabled)|\(selection.editDemoTrack)".utf8)); data.append(0)
        }
        for file in [manifestPath, commandPlanPath, recordingInfoPath, recordingMetadataPath, editInfoPath, editMetadataPath] {
            data.append(try Data(contentsOf: file))
        }
        return Data(SHA256.hash(data: data))
    }

    func cancelApply() {
        guard isApplying else { return }
        applyProcessController.cancel()
        answerPositionApproval(false)
        status = "Cancelling Apply"
        appendLog("Cancel requested. Completed Pro Tools changes will not be undone.")
    }

    func setConvertToSessionFormat(_ enabled: Bool) {
        if enabled {
            audioImportMode = .convertToSessionFormat
        }
    }

    func setLinkSourceAudioFiles(_ enabled: Bool) {
        if enabled {
            audioImportMode = .linkSource
        }
    }

    func openWorkFolder() {
        guard let workRoot else { return }
        NSWorkspace.shared.open(workRoot)
    }

    func addRecordingGroup() {
        let group = RecordingGroup(
            name: "Group \(recordingGroups.count + 1)",
            recordingReferenceTrack: "",
            targetTracks: []
        )
        recordingGroups.append(group)
        selectedRecordingGroupID = group.id
        reconcileEditGroupSelections()
    }

    func removeRecordingGroup(_ groupID: UUID) {
        recordingGroups.removeAll { $0.id == groupID }
        editGroupSelections.removeAll { $0.groupID == groupID }
        selectedRecordingGroupID = recordingGroups.first?.id
    }

    func groupNameBinding(for groupID: UUID) -> Binding<String> {
        groupBinding(groupID, keyPath: \.name, fallback: "")
    }

    func recordingReferenceBinding(for groupID: UUID) -> Binding<String> {
        Binding(
            get: { self.recordingGroups.first { $0.id == groupID }?.recordingReferenceTrack ?? "" },
            set: { self.selectRecordingReferenceTrack($0, groupID: groupID) }
        )
    }

    func isTargetTrackSelected(_ name: String, groupID: UUID) -> Bool {
        recordingGroups.first { $0.id == groupID }?.targetTracks.contains {
            $0.recordingSourceTrack == name
        } == true
    }

    func isTargetTrackAssignedElsewhere(_ name: String, groupID: UUID) -> Bool {
        recordingGroups.contains { group in
            group.id != groupID && group.targetTracks.contains { $0.recordingSourceTrack == name }
        }
    }

    func setTargetTrack(_ name: String, selected: Bool, groupID: UUID) {
        guard let track = recordingTracks.first(where: { $0.name == name }) else { return }
        setTargetTracks([track], selected: selected, groupID: groupID)
    }

    func setTargetTracks(_ tracks: [PTSLResponse.Body.Track], selected: Bool, groupID: UUID) {
        guard let groupIndex = recordingGroups.firstIndex(where: { $0.id == groupID }) else { return }
        let referenceTrack = recordingGroups[groupIndex].recordingReferenceTrack
        let names = Set(tracks.map(\.name)).subtracting([referenceTrack])
        if selected {
            for name in names where
                !isTargetTrackSelected(name, groupID: groupID)
                && !isTargetTrackAssignedElsewhere(name, groupID: groupID) {
                recordingGroups[groupIndex].targetTracks.append(TargetTrack(
                    recordingSourceTrack: name,
                    editDestinationTrack: defaultDestinationName(for: name)
                ))
            }
            sortTargetTracksByRecordingOrder(groupID: groupID)
        } else {
            recordingGroups[groupIndex].targetTracks.removeAll { names.contains($0.recordingSourceTrack) }
        }
    }

    func selectRecordingTracks(_ tracks: [PTSLResponse.Body.Track], groupID: UUID) {
        setTargetTracks(tracks, selected: true, groupID: groupID)
    }

    func clearTargetTracks(groupID: UUID) {
        guard let groupIndex = recordingGroups.firstIndex(where: { $0.id == groupID }) else { return }
        recordingGroups[groupIndex].targetTracks.removeAll()
    }

    func selectRecordingReferenceTrack(_ name: String, groupID: UUID) {
        guard let groupIndex = recordingGroups.firstIndex(where: { $0.id == groupID }) else { return }
        recordingGroups[groupIndex].recordingReferenceTrack = name
        recordingGroups[groupIndex].targetTracks.removeAll { $0.recordingSourceTrack == name }
    }

    func destinationBinding(for sourceTrack: String, groupID: UUID) -> Binding<String> {
        Binding(
            get: {
                self.recordingGroups.first { $0.id == groupID }?.targetTracks.first {
                    $0.recordingSourceTrack == sourceTrack
                }?.editDestinationTrack ?? ""
            },
            set: { newValue in
                guard let groupIndex = self.recordingGroups.firstIndex(where: { $0.id == groupID }),
                      let targetIndex = self.recordingGroups[groupIndex].targetTracks.firstIndex(where: {
                    $0.recordingSourceTrack == sourceTrack
                }) else { return }
                self.recordingGroups[groupIndex].targetTracks[targetIndex].editDestinationTrack = newValue
            }
        )
    }

    func editGroupEnabledBinding(for groupID: UUID) -> Binding<Bool> {
        groupSelectionBinding(groupID, keyPath: \.isEnabled, fallback: false)
    }

    func editDemoBinding(for groupID: UUID) -> Binding<String> {
        groupSelectionBinding(groupID, keyPath: \.editDemoTrack, fallback: "")
    }

    private func runTask(_ title: String, operation: @escaping () async throws -> Void) {
        guard !isRunning else { return }
        isRunning = true
        status = title
        workflowError = ""
        appendLog("")
        appendLog("== \(title) ==")

        Task {
            defer {
                self.isRunning = false
            }

            do {
                try await operation()
                self.status = title == "Apply To Edit Session" && self.applyReport?.partial == true ? "Apply Partially Complete" : "\(title) complete"
                self.appendLog("Done: \(title)")
            } catch is ApplyCancelled {
                if self.locatedSourceBeforeApply {
                    self.locatedSourceBeforeApply = false
                    self.status = "Source File Located"
                    self.presentApplyResult(title: "Source File Located", message: "Run Apply again to rebuild and check the plan. Save the Recording Profile to keep the new path. Previously imported tracks are unchanged.")
                } else {
                    self.status = "Apply cancelled"
                    self.presentApplyResult(title: "Apply cancelled", message: self.writeStarted
                        ? "Apply cancelled. Completed Pro Tools changes were not undone."
                        : "Cancelled before applying. No changes were made to the Pro Tools Session.")
                }
            } catch RunnerBridgeError.commandFailed(let result) {
                self.status = "\(title) failed"
                self.workflowError = self.conciseError(from: result)
                if title == "Apply To Edit Session", self.writeStarted,
                   let report = try? self.decodeFile(ApplyReport.self, at: self.applyPath) {
                    self.applyReport = report
                    self.resultIssues = (report.skipIssues ?? []) + (report.reviewIssues ?? [])
                    if report.cancelled == true {
                        self.status = "Apply cancelled"
                        self.presentApplyResult(title: "Apply cancelled", message: "Apply cancelled. Completed Pro Tools changes were not undone.")
                        self.appendResult(result)
                        return
                    }
                }
                self.appendResult(result)
                self.appendLog(result.combinedOutput)
                self.presentApplyFailureIfNeeded(for: title)
            } catch RunnerBridgeError.commandCancelled(let result) {
                if self.writeStarted, let report = try? self.decodeFile(ApplyReport.self, at: self.applyPath) {
                    self.applyReport = report
                    self.resultIssues = (report.skipIssues ?? []) + (report.reviewIssues ?? [])
                }
                self.status = "Apply cancelled"
                self.workflowError = self.writeStarted ? "Apply cancelled. Completed Pro Tools changes were not undone." : "Cancelled before applying. No changes were made to the Pro Tools Session."
                self.presentApplyResult(title: "Apply cancelled", message: self.workflowError)
                self.appendResult(result)
                self.appendLog(self.workflowError)
            } catch {
                self.status = "\(title) failed"
                self.workflowError = error.localizedDescription
                self.appendLog(error.localizedDescription)
                self.presentApplyFailureIfNeeded(for: title)
            }
        }
    }

    private func presentApplyFailureIfNeeded(for taskTitle: String) {
        guard taskTitle == "Apply To Edit Session" else { return }
        let reason = workflowError.isEmpty
            ? "AutoEdit could not apply the Recorded Tracks. Export diagnostics for details."
            : workflowError
        presentApplyResult(
            title: writeStarted ? "Apply Failed" : "Check Failed",
            message: reason + "\n\n" + (writeStarted ? "AutoEdit stopped. Any Pro Tools changes completed before the error were not undone." : "No changes were made to the Pro Tools Session.")
        )
    }

    private func presentApplyResult(title: String, message: String) {
        applyResultTitle = title
        applyResultMessage = message
        isApplyResultPresented = true
    }

    private func conciseError(from result: RunnerCommandResult) -> String {
        let lines = result.combinedOutput
            .split(whereSeparator: { $0.isNewline })
            .map(String.init)
        let priorities = ["CommandPlanExecutionError:", "Preflight blocked:", "Error:", "Missing", "failed"]
        for marker in priorities {
            if let line = lines.first(where: { $0.contains(marker) }) {
                return line
            }
        }
        return lines.first ?? "The operation failed. Export diagnostics for details."
    }

    private func bridge() throws -> RunnerBridge {
        guard let runnerRoot else {
            throw RunnerBridgeError.invalidRunnerRoot(runnerRootPath)
        }
        try ensureWorkDirectory()
        return RunnerBridge(runnerRoot: runnerRoot)
    }

    private func ensureWorkDirectory() throws {
        guard let workRoot else {
            throw RunnerBridgeError.invalidRunnerRoot(runnerRootPath)
        }
        try FileManager.default.createDirectory(at: workRoot, withIntermediateDirectories: true)
    }

    private func ensureProfileLibrary() throws {
        try FileManager.default.createDirectory(
            at: profileLibraryRoot,
            withIntermediateDirectories: true
        )
    }

    func refreshRecordingProfiles() {
        do {
            try ensureProfileLibrary()
            let folders = try FileManager.default.contentsOfDirectory(
                at: profileLibraryRoot,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )
            availableProfiles = folders.compactMap { folder in
                let profileURL = folder.appendingPathComponent("recording-profile.json")
                guard let profile = try? decodeFile(RecordingProfile.self, at: profileURL) else { return nil }
                return RecordingProfileSummary(
                    id: profile.id,
                    songName: profile.songName,
                    recordingSessionName: profile.recordingSessionName,
                    groupCount: profile.groups.count,
                    folderPath: folder.path,
                    createdAt: profile.createdAt,
                    updatedAt: profile.updatedAt
                )
            }.sorted { $0.songName.localizedStandardCompare($1.songName) == .orderedAscending }
        } catch {
            appendLog("Could not scan Recording Profiles: \(error.localizedDescription)")
        }
    }

    private func requiredWorkRoot() -> URL {
        if let workRoot {
            return workRoot
        }
        return RunnerBridge.applicationSupportRoot.appendingPathComponent("app-work", isDirectory: true)
    }

    private func readSession(_ mode: String, paths: [URL] = [], controller: RunnerProcessController? = nil) async throws -> SessionReadResponse {
        var arguments = [mode]
        if mode == "export" {
            arguments += ["--info", paths[0].path, "--metadata", paths[1].path, "--parsed", paths[2].path]
        }
        let result = try await bridge().runNpmScript("read-session", arguments: arguments, controller: controller)
        guard let data = extractFirstJSONObject(from: result.stdout) else {
            throw validationError("No Session read response was returned.")
        }
        let response = try decoder.decode(SessionReadResponse.self, from: data)
        appendLog("Session \(mode): \(response.body.track_list?.count ?? 0) tracks")
        appendLog("Diagnostics: \(response.diagnostics_path)")
        return response
    }

    private func fetchCurrentSessionSnapshot(controller: RunnerProcessController? = nil) async throws -> (name: String, tracks: [PTSLResponse.Body.Track]) {
        let response = try await readSession("snapshot", controller: controller)
        return (response.body.session_name ?? "", response.body.track_list ?? [])
    }

    private func updateCurrentSession(with snapshot: (name: String, tracks: [PTSLResponse.Body.Track])) {
        currentSessionName = snapshot.name
        currentTracks = snapshot.tracks
        currentTrackCount = snapshot.tracks.count
    }

    private func defaultDestinationName(for sourceName: String) -> String {
        if sourceName.hasPrefix("REC_") {
            return "CONF_" + sourceName.dropFirst(4)
        }
        return "CONF_" + sourceName
    }

    private func createDefaultRecordingGroup() {
        let reference = recommendedReferenceTrack(in: recordingTracks, forEditSession: false)?.name ?? ""
        let group = RecordingGroup(
            name: "Group 1",
            recordingReferenceTrack: reference,
            targetTracks: []
        )
        recordingGroups = [group]
        selectedRecordingGroupID = group.id
        reconcileEditGroupSelections(resetSelections: true)
    }

    private func sortTargetTracksByRecordingOrder(groupID: UUID) {
        guard let groupIndex = recordingGroups.firstIndex(where: { $0.id == groupID }) else { return }
        let order = Dictionary(uniqueKeysWithValues: recordingTracks.enumerated().map {
            ($0.element.name, $0.offset)
        })
        recordingGroups[groupIndex].targetTracks.sort {
            order[$0.recordingSourceTrack, default: .max]
                < order[$1.recordingSourceTrack, default: .max]
        }
    }

    private func reconcileRecordingGroups() {
        let availableNames = Set(recordingTracks.map(\.name))
        for groupIndex in recordingGroups.indices {
            if !availableNames.contains(recordingGroups[groupIndex].recordingReferenceTrack) {
                recordingGroups[groupIndex].recordingReferenceTrack = ""
            }
            let reference = recordingGroups[groupIndex].recordingReferenceTrack
            recordingGroups[groupIndex].targetTracks.removeAll {
                !availableNames.contains($0.recordingSourceTrack)
                    || $0.recordingSourceTrack == reference
            }
            sortTargetTracksByRecordingOrder(groupID: recordingGroups[groupIndex].id)
        }
        if recordingGroups.isEmpty {
            createDefaultRecordingGroup()
        }
        selectedRecordingGroupID = selectedRecordingGroupID.flatMap { selected in
            recordingGroups.contains { $0.id == selected } ? selected : recordingGroups.first?.id
        } ?? recordingGroups.first?.id
        reconcileEditGroupSelections()
    }

    private func reconcileEditGroupSelections(resetSelections: Bool = false) {
        let existing = Dictionary(uniqueKeysWithValues: editGroupSelections.map { ($0.groupID, $0) })
        editGroupSelections = recordingGroups.map { group in
            guard !resetSelections, var selection = existing[group.id] else {
                return EditGroupSelection(groupID: group.id, isEnabled: false, editDemoTrack: "")
            }
            if !editTracks.contains(where: { $0.name == selection.editDemoTrack }) {
                selection.editDemoTrack = ""
            }
            return selection
        }
    }

    private func groupBinding<Value>(
        _ groupID: UUID,
        keyPath: WritableKeyPath<RecordingGroup, Value>,
        fallback: Value
    ) -> Binding<Value> {
        Binding(
            get: { self.recordingGroups.first { $0.id == groupID }?[keyPath: keyPath] ?? fallback },
            set: { newValue in
                guard let index = self.recordingGroups.firstIndex(where: { $0.id == groupID }) else { return }
                self.recordingGroups[index][keyPath: keyPath] = newValue
            }
        )
    }

    private func groupSelectionBinding<Value>(
        _ groupID: UUID,
        keyPath: WritableKeyPath<EditGroupSelection, Value>,
        fallback: Value
    ) -> Binding<Value> {
        Binding(
            get: { self.editGroupSelections.first { $0.groupID == groupID }?[keyPath: keyPath] ?? fallback },
            set: { newValue in
                guard let index = self.editGroupSelections.firstIndex(where: { $0.groupID == groupID }) else { return }
                self.editGroupSelections[index][keyPath: keyPath] = newValue
            }
        )
    }

    private func recommendedReferenceTrack(
        in tracks: [PTSLResponse.Body.Track],
        forEditSession: Bool
    ) -> PTSLResponse.Body.Track? {
        let usable = tracks.filter { $0.containsClips && !$0.isInactive }
        let ranked = usable.enumerated().map { index, track in
            let name = track.name.lowercased()
            var score = 0
            if name.contains("demo") { score += 100 }
            if name.contains("mockup") { score += 90 }
            if name.contains("ref") { score += 80 }
            if forEditSession && name.contains("edit") { score += 30 }
            if !forEditSession && name.contains("rec") { score += 10 }
            return (track: track, score: score, index: index)
        }
        return ranked.max {
            $0.score == $1.score ? $0.index > $1.index : $0.score < $1.score
        }?.track
    }

    private func ensurePTSLConnection(controller: RunnerProcessController? = nil) async throws {
        let result = try await bridge().runNpmScript(
            "ptsl",
            arguments: ["register"],
            controller: controller
        )
        appendResult(result)
    }

    private func exportSessionInfo(
        to output: URL,
        controller: RunnerProcessController? = nil
    ) async throws {
        try await ensurePTSLConnection(controller: controller)
        let result = try await bridge().runNpmScript("export-session-info", arguments: [
            "--output", output.path
        ], controller: controller)
        appendResult(result)
    }

    private func parseSessionInfo(
        input: URL,
        output: URL,
        controller: RunnerProcessController? = nil
    ) async throws -> SessionParseSummary {
        let result = try await bridge().runNpmScript("parse-session-info", arguments: [
            "--input", input.path,
            "--output", output.path
        ], controller: controller)
        appendResult(result)
        guard let data = extractFirstJSONObject(from: result.stdout) else {
            throw NSError(domain: "AutoEdit", code: 2, userInfo: [NSLocalizedDescriptionKey: "No parse summary JSON"])
        }
        return try decoder.decode(SessionParseSummary.self, from: data)
    }

    private func sanitizedFolderName(_ value: String) -> String {
        let invalid = CharacterSet(charactersIn: "/:")
        let components = value.components(separatedBy: invalid)
        let sanitized = components.joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return sanitized.isEmpty ? "Untitled Recording" : sanitized
    }

    private func profileFolder(forSongName name: String) -> URL {
        profileLibraryRoot.appendingPathComponent(sanitizedFolderName(name), isDirectory: true)
    }

    private func profileURL(in folder: URL) -> URL {
        folder.appendingPathComponent("recording-profile.json")
    }

    private func recordingProfileSourceFiles() throws -> (root: String, files: [ProfileSourceFile]) {
        struct ParsedSession: Decodable {
            struct Track: Decodable {
                struct Event: Decodable {
                    let clipName: String
                    let sourceFile: String?
                }
                let name: String
                let events: [Event]
            }
            let tracks: [Track]
        }
        struct ClipMetadata: Decodable {
            struct FileLocation: Decodable {
                struct Info: Decodable { let is_online: Bool? }
                let path: String?
                let file_id: String?
                let info: Info?
            }
            struct Clip: Decodable {
                let clip_full_name: String?
                let file_id: String?
            }
            let file_locations: [FileLocation]?
            let clips: [Clip]?
        }

        let parsedSession = try decodeFile(ParsedSession.self, at: recordingParsedPath)
        let metadata = try decodeFile(ClipMetadata.self, at: recordingMetadataPath)
        let selectedNames = Set(recordingGroups.flatMap(\.targetTracks).map(\.recordingSourceTrack))
        let sourceTracks = parsedSession.tracks.filter { selectedNames.contains($0.name) }
        let locationsByID = (metadata.file_locations ?? []).reduce(into: [String: ClipMetadata.FileLocation]()) {
            result, location in
            if let fileID = location.file_id {
                result[fileID] = location
            }
        }
        let clipsByName = Dictionary(grouping: metadata.clips ?? []) { $0.clip_full_name ?? "" }
        var tracksByPath = [String: Set<String>]()
        var unresolvedFiles = Set<String>()
        for track in sourceTracks {
            for event in track.events {
                guard let sourceFile = event.sourceFile?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !sourceFile.isEmpty else { continue }
                let candidates = (clipsByName[event.clipName] ?? []).compactMap { clip -> ClipMetadata.FileLocation? in
                    guard let fileID = clip.file_id else { return nil }
                    return locationsByID[fileID]
                }
                let matchingSource = candidates.filter {
                    guard let path = $0.path else { return false }
                    return URL(fileURLWithPath: path).lastPathComponent.caseInsensitiveCompare(sourceFile) == .orderedSame
                }
                let matchingPaths = Set(matchingSource.compactMap(\.path))
                let candidatePaths = Set(candidates.compactMap(\.path))
                let resolvedPath = matchingPaths.count == 1
                    ? matchingPaths.first
                    : (candidatePaths.count == 1 ? candidatePaths.first : nil)
                guard let path = resolvedPath, !path.isEmpty else {
                    unresolvedFiles.insert(sourceFile)
                    continue
                }
                tracksByPath[path, default: []].insert(track.name)
            }
        }
        guard unresolvedFiles.isEmpty else {
            throw validationError(
                "Could not resolve \(unresolvedFiles.count) Recorded Track audio file(s): "
                    + unresolvedFiles.sorted().joined(separator: ", ")
            )
        }
        let onlineByPath = (metadata.file_locations ?? []).reduce(into: [String: Bool]()) { result, location in
            if let path = location.path {
                result[path] = (result[path] ?? false) || (location.info?.is_online ?? false)
            }
        }
        let selected: [(String, Bool, [String])] = tracksByPath.map { path, trackNames in
            (path, onlineByPath[path] ?? false, trackNames.sorted())
        }
        guard !selected.isEmpty else {
            throw validationError("No source WAV files were found for the selected Recorded Tracks.")
        }
        let commonRoot = selected.map { URL(fileURLWithPath: $0.0).deletingLastPathComponent().path }
            .reduce(nil as String?) { current, path in
                guard let current else { return path }
                var left = current.split(separator: "/")
                let right = path.split(separator: "/")
                while !left.isEmpty && !right.starts(with: left) { left.removeLast() }
                return "/" + left.joined(separator: "/")
            } ?? ""
        let files: [ProfileSourceFile] = selected.map { path, online, tracks in
            let relative = commonRoot.isEmpty
                ? URL(fileURLWithPath: path).lastPathComponent
                : String(path.dropFirst(commonRoot.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            return ProfileSourceFile(
                filename: URL(fileURLWithPath: path).lastPathComponent,
                absolutePath: path,
                relativePath: relative,
                trackNames: tracks,
                wasOnlineWhenSaved: online
            )
        }.sorted { $0.absolutePath.localizedStandardCompare($1.absolutePath) == .orderedAscending }
        return (commonRoot, files)
    }

    private func validateRecordingProfile() throws {
        let trimmedName = songName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { throw validationError("Song Name is required.") }
        guard !recordingSessionName.isEmpty && !recordingTracks.isEmpty else {
            throw validationError("Export a Recording Session before saving a profile.")
        }
        guard !recordingGroups.isEmpty else { throw validationError("Add at least one Recording Group.") }
        let availableNames = Set(recordingTracks.map(\.name))
        var assignedTracks = Set<String>()
        var groupNames = Set<String>()
        for group in recordingGroups {
            let groupName = group.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !groupName.isEmpty else { throw validationError("Every Recording Group needs a name.") }
            guard groupNames.insert(groupName.lowercased()).inserted else {
                throw validationError("Recording Group names must be unique.")
            }
            guard availableNames.contains(group.recordingReferenceTrack) else {
                throw validationError("Choose a Recording Reference Track for \(groupName).")
            }
            guard !group.targetTracks.isEmpty else {
                throw validationError("Choose at least one Recorded Track for \(groupName).")
            }
            for target in group.targetTracks {
                guard assignedTracks.insert(target.recordingSourceTrack).inserted else {
                    throw validationError("Recorded Track \(target.recordingSourceTrack) is assigned to more than one group.")
                }
                guard !target.editDestinationTrack.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw validationError("Every Recorded Track needs an Edit Destination name.")
                }
            }
        }
    }

    private func writeRecordingProfile() throws {
        try validateRecordingProfile()
        try ensureProfileLibrary()
        let now = Date()
        let existingSummary = availableProfiles.first { $0.id == loadedProfileID }
        let oldFolder = existingSummary.map { URL(fileURLWithPath: $0.folderPath) }
        let destinationFolder = profileFolder(forSongName: songName)
        let sourceInfo = try recordingProfileSourceFiles()
        if destinationFolder.path != oldFolder?.path && FileManager.default.fileExists(atPath: destinationFolder.path) {
            throw validationError("A Recording Profile named \(songName) already exists.")
        }
        if let oldFolder, oldFolder.path != destinationFolder.path {
            try FileManager.default.moveItem(at: oldFolder, to: destinationFolder)
        } else {
            try FileManager.default.createDirectory(at: destinationFolder, withIntermediateDirectories: true)
        }

        let existingProfile = try? decodeFile(RecordingProfile.self, at: profileURL(in: destinationFolder))
        let profile = RecordingProfile(
            schemaVersion: 1,
            id: existingProfile?.id ?? loadedProfileID ?? UUID(),
            songName: songName.trimmingCharacters(in: .whitespacesAndNewlines),
            recordingSessionName: recordingSessionName,
            sampleRate: Int(sampleRate) ?? 48000,
            audioRootPath: sourceInfo.root,
            createdAt: existingProfile?.createdAt ?? now,
            updatedAt: now,
            recordingTracks: recordingTracks,
            recordingSummary: recordingSummary,
            sourceFiles: sourceInfo.files,
            groups: recordingGroups
        )
        try encoder.encode(profile).write(to: profileURL(in: destinationFolder), options: .atomic)
        try FileManager.default.copyReplacing(recordingInfoPath, to: destinationFolder.appendingPathComponent("recording-session-info.txt"))
        try FileManager.default.copyReplacing(recordingMetadataPath, to: destinationFolder.appendingPathComponent("recording-clip-metadata.json"))
        try FileManager.default.copyReplacing(recordingParsedPath, to: destinationFolder.appendingPathComponent("recording-session-info.parsed.json"))
        selectedProfileID = profile.id
        loadedProfileID = profile.id
        selectedProfileFolderPath = destinationFolder.path
        profileSourceFiles = profile.sourceFiles
    }

    private func restoreRecordingProfile(_ id: UUID) throws {
        guard let summary = availableProfiles.first(where: { $0.id == id }) else {
            throw validationError("Recording Profile was not found.")
        }
        let folder = URL(fileURLWithPath: summary.folderPath)
        let profile = try decodeFile(RecordingProfile.self, at: profileURL(in: folder))
        try ensureWorkDirectory()
        try FileManager.default.copyReplacing(folder.appendingPathComponent("recording-session-info.txt"), to: recordingInfoPath)
        try FileManager.default.copyReplacing(folder.appendingPathComponent("recording-clip-metadata.json"), to: recordingMetadataPath)
        try FileManager.default.copyReplacing(folder.appendingPathComponent("recording-session-info.parsed.json"), to: recordingParsedPath)
        selectedProfileID = profile.id
        loadedProfileID = profile.id
        selectedProfileFolderPath = folder.path
        songName = profile.songName
        projectName = profile.songName
        sampleRate = String(profile.sampleRate)
        recordingSessionName = profile.recordingSessionName
        recordingTracks = profile.recordingTracks
        recordingSummary = profile.recordingSummary
        profileSourceFiles = profile.sourceFiles
        recordingGroups = profile.groups
        selectedRecordingGroupID = profile.groups.first?.id
        reconcileEditGroupSelections(resetSelections: true)
        if missingProfileSourceFileCount > 0 {
            appendLog("Warning: \(missingProfileSourceFileCount) referenced audio file(s) are currently unavailable.")
        }
    }

    private func clearLoadedRecordingProfile() {
        selectedProfileID = nil
        loadedProfileID = nil
        selectedProfileFolderPath = ""
        profileSourceFiles = []
        songName = ""
        recordingSessionName = ""
        recordingTracks = []
        recordingSummary = nil
        recordingGroups = []
        selectedRecordingGroupID = nil
        editGroupSelections = []
    }

    @discardableResult
    private func writeManifest(
        avoidingExistingTrackNames existingTrackNames: Set<String> = []
    ) throws -> [(original: String, resolved: String)] {
        let sampleRateValue = Int(sampleRate.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0

        guard sampleRateValue > 0 else {
            throw validationError("Sample Rate must be a positive number.")
        }
        let enabledSelections = editGroupSelections.filter(\.isEnabled)
        guard !enabledSelections.isEmpty else {
            throw validationError("Enable at least one Recording Group for this Edit Session.")
        }
        var reservedNames = existingTrackNames
        var renamedTracks: [(original: String, resolved: String)] = []
        let cues = try enabledSelections.map { selection -> ManifestDocument.Cue in
            guard let group = recordingGroups.first(where: { $0.id == selection.groupID }) else {
                throw validationError("An enabled Recording Group is missing from the loaded profile.")
            }
            let groupName = group.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let referenceTrack = group.recordingReferenceTrack.trimmingCharacters(in: .whitespacesAndNewlines)
            let demoTrack = selection.editDemoTrack.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !referenceTrack.isEmpty else {
                throw validationError("Choose a Recording Reference Track for \(groupName).")
            }
            guard !demoTrack.isEmpty else {
                throw validationError("Choose an Edited Demo Track for the enabled group \(groupName).")
            }
            guard !group.targetTracks.isEmpty else {
                throw validationError("The enabled group \(groupName) has no Recorded Tracks.")
            }
            guard group.targetTracks.allSatisfy({
                !$0.recordingSourceTrack.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && !$0.editDestinationTrack.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }) else {
                throw validationError("Every Recorded Track in \(groupName) needs an Edit Destination name.")
            }
            let resolvedTargets = group.targetTracks.map { target -> TargetTrack in
                let original = target.editDestinationTrack.trimmingCharacters(in: .whitespacesAndNewlines)
                var resolved = original
                var suffix = 2
                while reservedNames.contains(resolved.lowercased()) {
                    resolved = "\(original)_\(suffix)"
                    suffix += 1
                }
                reservedNames.insert(resolved.lowercased())
                if resolved != original {
                    renamedTracks.append((original: original, resolved: resolved))
                }
                return TargetTrack(
                    recordingSourceTrack: target.recordingSourceTrack,
                    editDestinationTrack: resolved
                )
            }
            return ManifestDocument.Cue(
                cueId: [cueId.trimmingCharacters(in: .whitespacesAndNewlines), sanitizedCueID(songName), sanitizedCueID(groupName)]
                    .filter { !$0.isEmpty }.joined(separator: "_"),
                recordingReferenceTrack: referenceTrack,
                editDemoTrack: demoTrack,
                targetTracks: resolvedTargets
            )
        }
        let destinationNames = cues.flatMap(\.targetTracks).map {
            $0.editDestinationTrack.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        guard Set(destinationNames).count == destinationNames.count else {
            throw validationError("Edit Destination track names must be unique across all enabled groups.")
        }

        let manifest = ManifestDocument(
            project: projectName,
            sampleRate: sampleRateValue,
            cues: cues
        )
        let data = try encoder.encode(manifest)
        try ensureWorkDirectory()
        try data.write(to: manifestPath, options: .atomic)
        return renamedTracks
    }

    private func sanitizedCueID(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let parts = value.unicodeScalars.map { allowed.contains($0) ? Character(String($0)) : "_" }
        return String(parts).uppercased()
    }

    private func validationError(_ message: String) -> NSError {
        NSError(
            domain: "AutoEdit.Validation",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    private func decodeFile<T: Decodable>(_ type: T.Type, at url: URL) throws -> T {
        let data = try Data(contentsOf: url)
        return try decoder.decode(type, from: data)
    }

    private func appendResult(_ result: RunnerCommandResult) {
        appendLog("$ \(result.arguments.joined(separator: " "))")
        appendLog("exit \(result.exitCode)")
        if !result.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            appendLog(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if !result.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            appendLog(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    private func appendLog(_ line: String) {
        if logText.isEmpty {
            logText = line
        } else {
            logText += "\n\(line)"
        }
    }
}

private extension FileManager {
    func copyReplacing(_ source: URL, to destination: URL) throws {
        if fileExists(atPath: destination.path) {
            try removeItem(at: destination)
        }
        try copyItem(at: source, to: destination)
    }
}
