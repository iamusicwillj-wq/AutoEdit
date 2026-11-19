import SwiftUI

private enum ProfileSortOrder: String, CaseIterable {
    case nameAscending, nameDescending, createdNewest, createdOldest, updatedNewest, updatedOldest

    var title: String {
        switch self {
        case .nameAscending: "Name: A–Z"
        case .nameDescending: "Name: Z–A"
        case .createdNewest: "Created: Newest First"
        case .createdOldest: "Created: Oldest First"
        case .updatedNewest: "Modified: Newest First"
        case .updatedOldest: "Modified: Oldest First"
        }
    }

    func precedes(_ lhs: RecordingProfileSummary, _ rhs: RecordingProfileSummary) -> Bool {
        switch self {
        case .createdNewest, .createdOldest:
            if lhs.createdAt != rhs.createdAt {
                return self == .createdNewest ? lhs.createdAt > rhs.createdAt : lhs.createdAt < rhs.createdAt
            }
        case .updatedNewest, .updatedOldest:
            if lhs.updatedAt != rhs.updatedAt {
                return self == .updatedNewest ? lhs.updatedAt > rhs.updatedAt : lhs.updatedAt < rhs.updatedAt
            }
        default: break
        }
        let nameOrder = lhs.songName.localizedStandardCompare(rhs.songName)
        if nameOrder != .orderedSame {
            return nameOrder == (self == .nameDescending ? .orderedDescending : .orderedAscending)
        }
        // Keep equivalent names and identical timestamps stable across refreshes.
        return lhs.id.uuidString < rhs.id.uuidString
    }
}

struct SavedProfilesView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("savedProfileSortOrder") private var sortOrder = ProfileSortOrder.nameAscending
    @State private var searchText = ""
    @State private var profilePendingDeletion: RecordingProfileSummary?

    private var visibleProfiles: [RecordingProfileSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.availableProfiles.filter { profile in
            query.isEmpty || profile.songName.localizedStandardContains(query)
                || profile.recordingSessionName.localizedStandardContains(query)
        }.sorted(by: sortOrder.precedes)
    }

    var body: some View {
        let profiles = visibleProfiles
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(L.text("Saved Profiles"))
                    .font(.headline)
                    .help(L.text("Drag the divider above to resize the profile list."))
                Spacer()
                Button {
                    model.refreshRecordingProfiles()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help(L.text("Refresh Saved Profiles"))
            }

            HStack {
                NewProfileButton()
                Spacer()
                Menu {
                    Picker(L.text("Sort Profiles"), selection: $sortOrder) {
                        ForEach(ProfileSortOrder.allCases, id: \.self) { order in
                            Text(L.text(order.title)).tag(order)
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
                // macOS caches menu items; rebuild them when the UI language changes.
                .id(model.language)
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityLabel(L.text("Sort Profiles"))
                .accessibilityValue(L.text(sortOrder.title))
                .help(L.text("Sort Profiles") + ": " + L.text(sortOrder.title))
            }

            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(L.text("Search profiles"), text: $searchText)
                    .textFieldStyle(.plain)
                    .help(L.text("Search song or Recording Session name"))
                if !searchText.isEmpty {
                    Button { searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help(L.text("Clear Search"))
                    .accessibilityLabel(L.text("Clear Search"))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))

            if model.availableProfiles.isEmpty {
                emptyMessage("No saved profiles")
            } else if profiles.isEmpty {
                emptyMessage("No matching profiles")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(profiles) { profile in
                            SavedProfileRow(
                                profile: profile,
                                isLoaded: model.loadedProfileIDForUI == profile.id,
                                onLoad: { model.loadRecordingProfile(profile.id) },
                                onDelete: { profilePendingDeletion = profile }
                            )
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .alert(L.text("Delete Recording Profile?"), isPresented: Binding(
            get: { profilePendingDeletion != nil },
            set: { if !$0 { profilePendingDeletion = nil } }
        ), presenting: profilePendingDeletion) { profile in
            Button(L.text("Delete"), role: .destructive) {
                model.deleteRecordingProfile(profile.id)
                profilePendingDeletion = nil
            }
            Button(L.text("Cancel"), role: .cancel) {
                profilePendingDeletion = nil
            }
        } message: { profile in
            Text(L.text("Delete \"\(profile.songName)\"? The saved profile data will be removed, but WAV files will not be touched."))
        }
    }

    private func emptyMessage(_ message: String) -> some View {
        Text(L.text(message))
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct SavedProfileRow: View {
    @EnvironmentObject private var localizationModel: AppModel
    let profile: RecordingProfileSummary
    let isLoaded: Bool
    let onLoad: () -> Void
    let onDelete: () -> Void

    var body: some View {
        Button(action: onLoad) {
            HStack(spacing: 8) {
                Text(profile.songName)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(L.text(profile.groupCount == 1 ? "1 group" : "\(profile.groupCount) groups"))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 5)
            .background(isLoaded ? Color.accentColor.opacity(0.12) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(profile.songName)
        .accessibilityAddTraits(isLoaded ? .isSelected : [])
        .contextMenu {
            Button(role: .destructive, action: onDelete) {
                Label(L.text("Delete Profile"), systemImage: "trash")
            }
        }
    }
}
