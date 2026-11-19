import XCTest
@testable import AutoEditApp

final class LocalizationTests: XCTestCase {
    private var savedLanguage: String?
    override func setUp() {
        savedLanguage = UserDefaults.standard.string(forKey: "interfaceLanguage")
        UserDefaults.standard.set("zh-Hans", forKey: "interfaceLanguage")
    }
    override func tearDown() {
        if let savedLanguage { UserDefaults.standard.set(savedLanguage, forKey: "interfaceLanguage") }
        else { UserDefaults.standard.removeObject(forKey: "interfaceLanguage") }
    }
    func testTerminologyAndLanguageSwitch() {
        XCTAssertEqual(L.text("Apply"), "执行")
        XCTAssertEqual(L.text("Recording Mockup Reference"), "参考轨")
        XCTAssertEqual(L.text("Edited Demo Track"), "参考轨")
        UserDefaults.standard.set("en", forKey: "interfaceLanguage")
        XCTAssertEqual(L.text("Apply"), "Apply")
        XCTAssertEqual(L.text("Recording Mockup Reference"), "Recording Mockup Reference")
    }
    func testParametersKeepUserNamesAndPathsVerbatim() {
        XCTAssertEqual(L.text("Recorded Tracks were successfully applied to \"String {session} 工程\"."), "已执行完成，实录轨道已导入“String {session} 工程”。")
        XCTAssertEqual(L.text("Expected Pro Tools session \"{actual}\", got \"Second\"."), "预期导入工程为“{actual}”，当前打开的工程为“Second”。")
        XCTAssertEqual(L.text("Source path does not exist: /Volumes/Backup/STR MIX.wav"), "源文件路径不存在：/Volumes/Backup/STR MIX.wav")
        XCTAssertEqual(L.text("Group Brass  ·  4 tracks"), "Group Brass · 4 条轨道")
        XCTAssertEqual(L.text("2 groups, 12 referenced audio files"), "2 个组，引用 12 个音频文件")
    }
    func testStatusAndReorderedErrorParameters() {
        XCTAssertEqual(L.text("Apply To Edit Session complete"), "执行完成")
        XCTAssertEqual(L.text("Save Recording Profile failed"), "保存录音配置失败")
        XCTAssertEqual(L.text("CreateFades failed on Violin at samples 100–200: Host busy"), "“Violin”在 100–200 采样点执行 CreateFades 失败：Host busy")
    }
    func testPositionWarningAndUnknownErrorAreLocalized() throws {
        let data = Data(#"{"severity":"warning","code":"position-gap","message":"No coverage","destinationTrack":"STR","timelineStartSamples":100,"timelineEndSamples":200}"#.utf8)
        let issue = try JSONDecoder().decode(WorkflowIssue.self, from: data)
        XCTAssertEqual(L.issue(issue), "STR：100–200 采样点无对应录音，执行后该区间将保持空缺，其他片段不会移动。")
        XCTAssertTrue(L.error("CEType_Unknown: diagnostic").hasPrefix("发生错误"))
        UserDefaults.standard.set("en", forKey: "interfaceLanguage")
        XCTAssertEqual(L.issue(issue), "No coverage")
    }
    func testPartialResultAndSkipDetails() throws {
        XCTAssertEqual(L.text("Applied 4 clip groups. Some items were skipped. Review the list below."), "已导入 4 个片段组。部分项目已跳过，请检查下方清单。")
        let data = Data(#"{"code":"unverified-mapping","message":"Wrong reference","destinationTrack":"SOLO","demoClipName":"STRING-04","timelineStartSamples":100,"timelineEndSamples":200,"action":"skip-unmapped"}"#.utf8)
        let issue = try JSONDecoder().decode(WorkflowIssue.self, from: data)
        let text = L.issue(issue)
        XCTAssertTrue(text.contains("SOLO · STRING-04"))
        XCTAssertTrue(text.contains("100–200 采样点"))
        XCTAssertFalse(text.contains("Wrong reference"))
        XCTAssertTrue(text.contains("跳过"))
        UserDefaults.standard.set("en", forKey: "interfaceLanguage")
        XCTAssertTrue(L.issue(issue).contains("Wrong reference"))
        XCTAssertTrue(L.issue(issue).contains("Skip unmapped audio"))
    }

    func testImportAnywayChoiceAndMissingFadeDetails() throws {
        XCTAssertEqual(L.text("Import audio for manual correction"), "仍然导入，稍后人工修正")
        let data = Data(#"{"code":"reference-fade-coverage","message":"Reference fade is uncovered","destinationTrack":"MIDI","timelineStartSamples":100,"timelineEndSamples":207974,"durationSeconds":4.330708333,"action":"import-for-review"}"#.utf8)
        let issue = try JSONDecoder().decode(WorkflowIssue.self, from: data)
        XCTAssertTrue(L.issue(issue).contains("4.331 秒"))
        XCTAssertTrue(L.issue(issue).contains("之后检查"))
        XCTAssertFalse(L.issue(issue).contains("跳过"))
        UserDefaults.standard.set("en", forKey: "interfaceLanguage")
        XCTAssertTrue(L.issue(issue).contains("Import available audio"))
        XCTAssertTrue(L.issue(issue).contains("4.331 seconds"))
    }

    func testBothApprovalPlansDecodeWithDistinctDigestsWhenSkipWouldBeEmpty() throws {
        let data = Data(#"{"preflight":{"needsSkipApproval":false,"policyDigest":"skip-digest","uncertainAudio":"skip","fatalIssues":[{"code":"nothing-to-apply","message":"Nothing left"}],"summary":{"clipGroups":0},"importAnyway":{"needsSkipApproval":true,"policyDigest":"import-digest","uncertainAudio":"import","fatalIssues":[],"approvalIssues":[{"code":"unverified-mapping","message":"Review position","action":"import-for-review"}],"summary":{"clipGroups":1}}}}"#.utf8)
        let report = try JSONDecoder().decode(ApplyReport.self, from: data)
        XCTAssertEqual(report.preflight?.summary?.clipGroups, 0)
        XCTAssertEqual(report.preflight?.importAnyway?.summary?.clipGroups, 1)
        XCTAssertEqual(report.preflight?.importAnyway?.approvalIssues?.first?.action, "import-for-review")
        XCTAssertEqual(report.preflight?.importAnyway?.policyDigest, "import-digest")
        XCTAssertNotEqual(report.preflight?.policyDigest, report.preflight?.importAnyway?.policyDigest)
    }

    func testReferenceAliasAndGapApprovalDoNotClaimTheClipWillBeDiscarded() throws {
        let message = "Reference filenames differ: \"ref.1.wav\" and \"ref.wav\". Confirm that the selected references share the same source timing. Importing keeps the proposed audio and usable fades."
        let data = try JSONSerialization.data(withJSONObject: ["code":"reference-name-mismatch", "message":message, "action":"import-for-review"])
        let alias = try JSONDecoder().decode(WorkflowIssue.self, from: data)
        XCTAssertTrue(L.issue(alias).contains("ref.1.wav"))
        XCTAssertTrue(L.issue(alias).contains("ref.wav"))
        XCTAssertTrue(L.issue(alias).contains("确认"))
        XCTAssertTrue(L.issue(alias).contains("可用淡变"))
        XCTAssertFalse(L.issue(alias).contains("跳过"))
        let gap = try JSONDecoder().decode(WorkflowIssue.self, from: Data(#"{"code":"position-gap","message":"Missing head","action":"keep-audio","durationSeconds":0.265229}"#.utf8))
        XCTAssertTrue(L.issue(gap).contains("保留"))
        XCTAssertTrue(L.issue(gap).contains("0.265 秒"))
        XCTAssertFalse(L.issue(gap).contains("跳过"))
        XCTAssertEqual(L.text("Continue with available audio and fades"), "保留可用音频和淡变并继续")
        UserDefaults.standard.set("en", forKey: "interfaceLanguage")
        XCTAssertTrue(L.issue(gap).contains("Keep available audio"))
    }

    func testShortenedCrossfadeIsNamedCorrectly() throws {
        let issue = try JSONDecoder().decode(WorkflowIssue.self, from: Data(#"{"code":"shortened-fade","message":"Shortened","type":"crossfade","timelineStartSamples":100,"timelineEndSamples":300,"appliedStartSamples":110,"appliedEndSamples":300}"#.utf8))
        XCTAssertTrue(L.issue(issue).contains("交叉淡变"))
        XCTAssertTrue(L.issue(issue).contains("110–300"))
    }

}
