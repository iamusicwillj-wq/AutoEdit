import Foundation

enum SourceRelink {
    // Update only locations and online flags; source coordinates and IDs stay
    // unchanged. Audio identity is confirmed by the user, not inferred by name.
    static func metadata(_ data: Data, oldPath: String, newPath: String,
                         sampleRate: Double, expectedSampleRate: Int,
                         frames: Int64, channels: Int, requiredChannels: Int) throws -> Data {
        func failure(_ message: String) -> NSError {
            NSError(domain: "AutoEdit.SourceRelink", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        guard sampleRate == Double(expectedSampleRate), expectedSampleRate > 0 else {
            throw failure("The selected file has a different sample rate from the Recording Session.")
        }
        guard requiredChannels > 0, channels >= requiredChannels else {
            throw failure("The selected file does not contain all required audio channels.")
        }
        guard var metadata = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw failure("Recording metadata could not be read.")
        }
        let locationsKey = metadata["file_locations"] != nil ? "file_locations" : "fileLocations"
        var locations = metadata[locationsKey] as? [[String: Any]] ?? []
        let ids = Set(locations.filter { $0["path"] as? String == oldPath }.compactMap { $0["file_id"] as? String ?? $0["fileId"] as? String })
        guard !ids.isEmpty else { throw failure("The source path is no longer present in the loaded Recording Profile.") }
        var clips = metadata["clips"] as? [[String: Any]] ?? []
        let indices = clips.indices.filter { ids.contains(clips[$0]["file_id"] as? String ?? clips[$0]["fileId"] as? String ?? "") }
        let ends = indices.compactMap { index -> Int64? in
            let point = clips[index]["src_end_point"] as? [String: Any] ?? clips[index]["srcEndPoint"] as? [String: Any]
            if let value = point?["position"] as? NSNumber { return value.int64Value }
            if let value = point?["position"] as? String { return Int64(value) }
            return nil
        }
        guard !indices.isEmpty, ends.count == indices.count, let last = ends.max(), last > 0, frames >= last else {
            throw failure("The selected file is too short or its required source range cannot be verified.")
        }
        for index in locations.indices where locations[index]["path"] as? String == oldPath {
            locations[index]["path"] = newPath
            var info = locations[index]["info"] as? [String: Any] ?? [:]
            info["is_online"] = true
            locations[index]["info"] = info
        }
        for index in indices { clips[index]["is_online"] = true }
        metadata[locationsKey] = locations
        metadata["clips"] = clips
        return try JSONSerialization.data(withJSONObject: metadata, options: [.prettyPrinted, .sortedKeys])
    }
}
