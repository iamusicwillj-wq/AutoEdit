import XCTest
@testable import AutoEditApp

final class SourceRelinkTests: XCTestCase {
    private let fixture = Data(#"{"file_locations":[{"file_id":"a","path":"/old.wav","info":{"is_online":false}},{"file_id":"b","path":"/other.wav"}],"clips":[{"file_id":"a","src_start_point":{"position":100},"src_end_point":{"position":1000},"is_online":false},{"file_id":"b","src_end_point":{"position":9000}}]}"#.utf8)
    func testRelinkPreservesCoordinatesAndUnrelatedFiles() throws {
        let data = try SourceRelink.metadata(fixture, oldPath: "/old.wav", newPath: "/new.wav", sampleRate: 48000, expectedSampleRate: 48000, frames: 1000, channels: 2, requiredChannels: 2)
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let locations = try XCTUnwrap(result["file_locations"] as? [[String: Any]])
        XCTAssertEqual(locations[0]["path"] as? String, "/new.wav")
        XCTAssertEqual(locations[1]["path"] as? String, "/other.wav")
        let clips = try XCTUnwrap(result["clips"] as? [[String: Any]])
        XCTAssertEqual((clips[0]["src_start_point"] as? [String: Int])?["position"], 100)
        XCTAssertEqual((clips[0]["src_end_point"] as? [String: Int])?["position"], 1000)
        XCTAssertEqual(clips[0]["file_id"] as? String, "a")
        XCTAssertEqual(clips[0]["is_online"] as? Bool, true)
        XCTAssertEqual((clips[1]["src_end_point"] as? [String: Int])?["position"], 9000)
    }
    func testIncompatibleFilesDoNotProduceRewrittenMetadata() {
        for (rate, length, channels) in [(44100.0, Int64(1000), 2), (48000.0, 999, 2), (48000.0, 1000, 1)] {
            XCTAssertThrowsError(try SourceRelink.metadata(fixture, oldPath: "/old.wav", newPath: "/new.wav", sampleRate: rate, expectedSampleRate: 48000, frames: length, channels: channels, requiredChannels: 2))
        }
        XCTAssertThrowsError(try SourceRelink.metadata(fixture, oldPath: "/absent.wav", newPath: "/new.wav", sampleRate: 48000, expectedSampleRate: 48000, frames: 1000, channels: 2, requiredChannels: 2))
    }
    func testFileAccessAndWholeTrackOmissionAreLocalized() throws {
        let old = UserDefaults.standard.string(forKey: "interfaceLanguage")
        defer { if let old { UserDefaults.standard.set(old, forKey: "interfaceLanguage") } else { UserDefaults.standard.removeObject(forKey: "interfaceLanguage") } }
        UserDefaults.standard.set("zh-Hans", forKey: "interfaceLanguage")
        let issue = try JSONDecoder().decode(WorkflowIssue.self, from: Data(#"{"code":"source-access-denied","message":"Denied","action":"skip-clip","sourcePath":"/audio.wav","fileErrorCode":"EPERM"}"#.utf8))
        XCTAssertTrue(issue.canLocateSource)
        XCTAssertTrue(L.issue(issue).contains("权限被拒绝"))
        XCTAssertTrue(L.issue(issue).contains("EPERM"))
        let track = try JSONDecoder().decode(WorkflowIssue.self, from: Data(#"{"code":"empty-destination-track","message":"Empty","action":"skip-track","destinationTrack":"AG 3"}"#.utf8))
        XCTAssertTrue(L.issue(track).contains("整条轨道不会被创建或导入"))
        XCTAssertFalse(track.canLocateSource)
    }
}
