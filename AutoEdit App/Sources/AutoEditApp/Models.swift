import Foundation

struct PTSLResponse: Decodable {
    struct Header: Decodable {
        let status: String?
    }

    struct Body: Decodable {
        struct Track: Codable, Identifiable, Equatable {
            struct Attributes: Codable, Equatable {
                let contains_clips: Bool?
                let is_inactive: String?
                let is_hidden: String?
            }

            let name: String
            let type: String?
            let format: String?
            let index: Int?
            let parent_folder_name: String?
            let track_attributes: Attributes?

            var id: String { name }

            var isAudio: Bool { type == "TT_Audio" }
            var containsClips: Bool { track_attributes?.contains_clips == true }
            var isInactive: Bool {
                guard let state = track_attributes?.is_inactive else { return false }
                return state != "None"
            }

            var isHidden: Bool {
                guard let state = track_attributes?.is_hidden else { return false }
                return state != "None"
            }

            var formatLabel: String {
                switch format {
                case "TF_Mono": "Mono"
                case "TF_Stereo": "Stereo"
                default: format ?? "Unknown"
                }
            }
        }

        let session_name: String?
        let track_list: [Track]?
    }

    let header: Header?
    let body: Body?
}

struct SessionParseSummary: Codable {
    let sessionName: String?
    let sampleRate: Double?
    let onlineFiles: Int?
    let onlineClips: Int?
    let tracks: Int?
    let trackEvents: Int?
    let audioEvents: Int?
    let markers: Int?
    let warnings: Int?
}

struct ConformPlan: Decodable {
    struct Summary: Decodable {
        struct Diagnostics: Decodable {
            let offlineSourceClips: Int?
            let offlineSourceFiles: Int?
            let missingSourceFilePaths: Int?
            let clipsFromInactiveSourceTracks: Int?
            let clipsFromInactiveDemoTracks: Int?
        }

        let cues: Int?
        let outputClipEntries: Int?
        let gaps: Int?
        let gapSamples: Int?
        let transitions: Int?
        let transitionSamples: Int?
        let diagnostics: Diagnostics?
        let warnings: Int?
    }

    let summary: Summary
    let warnings: [String]?
}

struct CommandPlan: Decodable {
    struct Summary: Decodable {
        let imports: Int?
        let createTracks: Int?
        let clipGroups: Int?
        let fadeGroups: Int?
        let channelClipEntries: Int?
        let transitionEntries: Int?
        let warnings: Int?
        let fatalIssues: Int?
    }

    let summary: Summary
    let warnings: [String]?
    let fatalIssues: [String]?
    let reviewNotes: [String]?
}

struct ApplyReport: Decodable {
    final class Preflight: Decodable {
        struct Summary: Decodable {
            let imports: Int?
            let createTracks: Int?
            let clipGroups: Int?
            let fadeGroups: Int?
            let warnings: Int?
            let fatalIssues: Int?
            let blockers: Int?
        }

        let needsSkipApproval: Bool?
        let importAnyway: Preflight?
        let approvalIssues: [WorkflowIssue]?
        let uncertainAudio: String?
        let skipIssues: [WorkflowIssue]?
        let policyDigest: String?
        let needsPositionApproval: Bool?
        let fatalIssues: [WorkflowIssue]?
        let positionWarnings: [WorkflowIssue]?
        let reviewIssues: [WorkflowIssue]?
        let blockers: [WorkflowIssue]?
        let okToExecute: Bool?
        let summary: Summary?
    }

    let execute: Bool?
    let preflight: Preflight?
    let failedCommands: Int?
    let partial: Bool?
    let cancelled: Bool?
    let completedClips: Int?
    let skipIssues: [WorkflowIssue]?
    let reviewIssues: [WorkflowIssue]?
}

struct TargetTrack: Identifiable, Codable, Equatable {
    var id = UUID()
    var recordingSourceTrack: String
    var editDestinationTrack: String

    enum CodingKeys: String, CodingKey {
        case recordingSourceTrack = "recording_source_track"
        case editDestinationTrack = "edit_destination_track"
    }
}

struct RecordingGroup: Identifiable, Codable, Equatable {
    var id = UUID()
    var name: String
    var recordingReferenceTrack: String
    var targetTracks: [TargetTrack]

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case recordingReferenceTrack = "recording_reference_track"
        case targetTracks = "target_tracks"
    }
}

struct EditGroupSelection: Identifiable, Equatable {
    var id: UUID { groupID }
    var groupID: UUID
    var isEnabled: Bool
    var editDemoTrack: String
}

struct ProfileSourceFile: Codable, Identifiable, Equatable {
    var id: String { absolutePath }
    var filename: String
    var absolutePath: String
    var relativePath: String
    var trackNames: [String]
    var wasOnlineWhenSaved: Bool

    enum CodingKeys: String, CodingKey {
        case filename
        case absolutePath = "absolute_path"
        case relativePath = "relative_path"
        case trackNames = "track_names"
        case wasOnlineWhenSaved = "was_online_when_saved"
    }
}

struct RecordingProfile: Codable, Identifiable {
    var schemaVersion: Int
    var id: UUID
    var songName: String
    var recordingSessionName: String
    var sampleRate: Int
    var audioRootPath: String
    var createdAt: Date
    var updatedAt: Date
    var recordingTracks: [PTSLResponse.Body.Track]
    var recordingSummary: SessionParseSummary?
    var sourceFiles: [ProfileSourceFile]
    var groups: [RecordingGroup]

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case id
        case songName = "song_name"
        case recordingSessionName = "recording_session_name"
        case sampleRate = "sample_rate"
        case audioRootPath = "audio_root_path"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case recordingTracks = "recording_tracks"
        case recordingSummary = "recording_summary"
        case sourceFiles = "source_files"
        case groups
    }
}

struct RecordingProfileSummary: Identifiable, Equatable {
    var id: UUID
    var songName: String
    var recordingSessionName: String
    var groupCount: Int
    var folderPath: String
    var createdAt: Date
    var updatedAt: Date
}

struct ManifestDocument: Codable {
    struct Cue: Codable {
        var cueId: String
        var recordingReferenceTrack: String
        var editDemoTrack: String
        var targetTracks: [TargetTrack]

        enum CodingKeys: String, CodingKey {
            case cueId = "cue_id"
            case recordingReferenceTrack = "recording_reference_track"
            case editDemoTrack = "edit_demo_track"
            case targetTracks = "target_tracks"
        }
    }

    var project: String
    var sampleRate: Int
    var cues: [Cue]

    enum CodingKeys: String, CodingKey {
        case project
        case sampleRate = "sample_rate"
        case cues
    }
}

struct SessionReadResponse: Decodable {
    struct Body: Decodable {
        let session_name: String?
        let track_list: [PTSLResponse.Body.Track]?
        let summary: SessionParseSummary?
    }
    let body: Body
    let diagnostics_path: String
}

struct WorkflowIssue: Decodable {
    let severity: String?
    let code: String?
    let message: String
    let destinationTrack: String?
    let sourceTrack: String?
    let channel: Int?
    let type: String?
    let timelineStartSamples: Int?
    let timelineEndSamples: Int?
    let appliedStartSamples: Int?
    let appliedEndSamples: Int?
    let action: String?
    let clipName: String?
    let demoClipName: String?
    let sourcePath: String?
    let fileErrorCode: String?
    let command: String?
    let durationSeconds: Double?

    var canLocateSource: Bool {
        sourcePath?.isEmpty == false && ["path-not-found", "source-access-denied", "source-not-file", "source-read-failed"].contains(code ?? "")
    }
}

struct RuntimeApprovalRequest: Decodable {
    let runID: String
    let token: String
    let issue: WorkflowIssue
}
