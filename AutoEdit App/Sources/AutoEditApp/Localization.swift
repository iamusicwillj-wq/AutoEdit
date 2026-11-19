import Foundation

enum L {
    static var isChinese: Bool {
        let choice = UserDefaults.standard.string(forKey: "interfaceLanguage") ?? "system"
        return choice == "zh-Hans" || (choice == "system" && (Locale.preferredLanguages.first ?? "en").hasPrefix("zh"))
    }
    private static let translations: [String: String] = {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("AutoEditApp_AutoEditApp.bundle")
        let resources = bundled.flatMap { Bundle(url: $0) } ?? Bundle.module
        guard let url = resources.url(forResource: "zh-Hans", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return value
    }()
    private static let templates: [(NSRegularExpression, [String], String)] = translations.keys.sorted {
        let token = try! NSRegularExpression(pattern: #"\{[^}]+\}"#)
        func specificity(_ key: String) -> Int {
            token.stringByReplacingMatches(in: key, range: NSRange(location: 0, length: (key as NSString).length), withTemplate: "").count
        }
        let left = specificity($0), right = specificity($1)
        return left == right ? $0 < $1 : left > right
    }.compactMap { key in
        guard key.contains("{") else { return nil }
        let token = try! NSRegularExpression(pattern: #"\{([^}]+)\}"#)
        let ns = key as NSString
        let matches = token.matches(in: key, range: NSRange(location: 0, length: ns.length))
        var pattern = "^", cursor = 0
        var names: [String] = []
        for match in matches {
            pattern += NSRegularExpression.escapedPattern(for: ns.substring(with: NSRange(location: cursor, length: match.range.location-cursor))) + "(.*?)"
            names.append(ns.substring(with: match.range))
            cursor = match.range.location + match.range.length
        }
        pattern += NSRegularExpression.escapedPattern(for: ns.substring(from: cursor)) + "$"
        return (try! NSRegularExpression(pattern: pattern, options: .dotMatchesLineSeparators), names, translations[key]!)
    }
    static func text(_ value: String) -> String {
        guard isChinese else { return value }
        if let translated = translations[value] { return translated }
        for suffix in [" complete", " failed"] where value.hasSuffix(suffix) {
            return text(String(value.dropLast(suffix.count))) + (suffix == " complete" ? "完成" : "失败")
        }
        if value.contains("\n") { return value.components(separatedBy: "\n").map(text).joined(separator: "\n") }
        let ns = value as NSString
        for (regex, names, format) in templates {
            if let match = regex.firstMatch(in: value, range: NSRange(location: 0, length: ns.length)) {
                var output = format
                // Replace once using placeholders; user values are never translated.
                let token = try! NSRegularExpression(pattern: #"\{[^}]+\}"#)
                let placeholders = token.matches(in: format, range: NSRange(location: 0, length: (format as NSString).length))
                let result = NSMutableString(string: format)
                for placeholder in placeholders.reversed() {
                    let name = (format as NSString).substring(with: placeholder.range)
                    if let i = names.firstIndex(of: name) {
                        result.replaceCharacters(in: placeholder.range, with: ns.substring(with: match.range(at: i+1)))
                    }
                }
                output = result as String
                return output
            }
        }
        return value
    }
    static func error(_ value: String) -> String {
        let translated = text(value)
        if isChinese && translated == value && !value.isEmpty {
            return "发生错误，请查看原始详情或导出诊断包。\n" + value
        }
        return translated
    }
    static func issue(_ issue: WorkflowIssue) -> String {
        if let action = issue.action {
            let detail = [issue.destinationTrack, issue.clipName ?? issue.demoClipName, issue.sourcePath].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            let range = issue.timelineStartSamples.map { "\($0)–\(issue.timelineEndSamples ?? $0) " + (isChinese ? "采样点" : "samples") } ?? ""
            let actions = ["skip-clip": "Skip entire clip", "skip-unmapped": "Skip unmapped audio and its fades", "skip-fade": "Skip fade; keep imported audio", "skip-file": "Skip this file and dependent clips", "skip-track": "Skip this track", "import-for-review": "Import available audio and usable fades at the proposed positions; review afterward", "keep-audio": "Keep available audio and usable fades; only the listed interval remains uncovered"]
            let reasons = ["position-gap":"No corresponding recording covers this interval.",
                "position-reference-partial":"Recording Reference does not cover this source range.",
                "unverified-mapping":"The source identity or position mapping could not be verified.",
                "reference-name-mismatch":"Reference filenames differ. Confirm that the selected references share the same source timing.",
                "unverified-recording-range":"Recorded clip source positions could not be verified.",
                "unresolved-fade":"The fade could not be rebuilt reliably.",
                "reference-fade-coverage":"Part of the reference fade has no audio coverage in the plan.",
                "missing-track-mapping":"A selected source or reference track is unavailable.",
                "missing-channels":"Required clip channels are missing or inconsistent.",
                "path-not-found":"The source path was not found. Locate the original audio file or restore its path.", "offline-source-file":"The source file is unavailable.",
                "source-access-denied":"Permission to read the source file was denied. Check macOS file access permissions or locate an accessible copy.",
                "source-not-file":"The source path points to a folder, not an audio file.",
                "empty-destination-track":"All clips on this destination track were skipped. This track will not be created.",
                "offline-source-clip":"The source clip is offline.", "missing-source-file-path":"The source path is missing.",
                "target-track-unverified":"The identity of the new target track could not be verified.",
                "target-track-exists":"A target track with this name already exists.",
                "dependent-clip":"A required source file was skipped.", "dependent-fade":"A required clip or track was skipped.",
                "command-failed":"Pro Tools returned an explicit command failure.",
                "import-no-file":"Import did not return a usable file ID.", "clip-no-id":"Creation did not return a usable clip ID.",
                "source-read-failed":"The source file could not be read.", "invalid-clip-range":"Clip positions are invalid.",
                "fade-selection-changed":"Track or timeline selection changed before creating the fade."]
            let reason = isChinese
                ? text(issue.code == "reference-name-mismatch" ? issue.message : (reasons[issue.code ?? ""] ?? "This item could not be processed reliably."))
                : issue.message
            let duration = issue.durationSeconds.map { text("Uncovered audio: \(String(format: "%.3f", $0)) seconds") } ?? ""
            let fileError = issue.fileErrorCode.map { text("File access error: \($0)") } ?? ""
            return [detail,range,reason,fileError,duration,text(actions[action] ?? "Skip this item")].filter { !$0.isEmpty }.joined(separator: "\n")
        }
        guard isChinese else { return issue.message }
        let track = issue.destinationTrack ?? issue.sourceTrack ?? ""
        let range = "\(issue.timelineStartSamples ?? 0)–\(issue.timelineEndSamples ?? 0) 采样点"
        switch issue.code {
        case "recovered-fade-boundary": return "\(track)，\(range)：已利用所选参考轨映射和源文件余量补齐淡变内的音频，原有音频位置保持不变。请试听检查此处淡变。"
        case "extended-reference-mapping": return "\(track)，\(range)：已沿用参考轨唯一的采样位置关系，读取其裁切范围之外的可用录音。已有音频位置未改变。"
        case "position-gap": return "\(track)：\(range)无对应录音，执行后该区间将保持空缺，其他片段不会移动。"
        case "position-reference-partial": return "\(track)：\(range) 的参考音频未被录音工程参考轨完整覆盖。只能导入可对应的部分，请核对结果。"
        case "shortened-fade":
            let kind = issue.type == "crossfade" ? "交叉淡变" : (issue.type == "fade-in" ? "淡入" : "淡出")
            return "\(track)，声道 \(issue.channel ?? 1)：\(kind)由 \(range) 缩短至 \(issue.appliedStartSamples ?? 0)–\(issue.appliedEndSamples ?? 0) 采样点。音频位置未改变，请试听检查。"
        case "inactive-source-track": return "录音轨道“\(track)”未激活，已按所选轨道读取素材。请检查执行结果。"
        case "unresolved-fade": return "\(track)，\(range)：无法可靠重建淡变。可能缺少源文件余量，或存在不同 take 的接点。\n" + issue.message
        default: return error(issue.message)
        }
    }
}
