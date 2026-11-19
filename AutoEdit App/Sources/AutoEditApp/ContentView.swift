import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .environmentObject(model)
        } detail: {
            MainWorkflowView()
                .environmentObject(model)
        }
        .sheet(isPresented: $model.isApplyResultPresented) {
            WorkflowResultView()
                .environmentObject(model)
        }
        .sheet(isPresented: $model.isPositionApprovalPresented) {
            PositionApprovalView().environmentObject(model)
        }

    }
}

private struct SidebarView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VSplitView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L.text("AutoEdit"))
                            .font(.title2.weight(.semibold))
                        Text(L.text(model.status))
                            .foregroundStyle(model.isRunning ? .orange : .secondary)
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 8) {
                        Text(L.text("Current Session"))
                            .font(.headline)
                        Label(model.currentSessionName.isEmpty ? L.text("Unknown") : model.currentSessionName, systemImage: "waveform")
                        Label(L.text(trackCountText), systemImage: "rectangle.stack")
                        Button {
                            model.checkCurrentSession()
                        } label: {
                            Label(L.text("Refresh"), systemImage: "arrow.clockwise")
                        }
                        .disabled(model.isRunning)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .frame(minHeight: 100, idealHeight: 200, maxHeight: 360)

            SavedProfilesView()
                .disabled(model.isApplying)
                .padding(16)
                .frame(minHeight: 240, idealHeight: 480, maxHeight: .infinity)
        }
        .navigationSplitViewColumnWidth(min: 260, ideal: 320)
    }

    private var trackCountText: String {
        guard let count = model.currentTrackCount else { return "Tracks unknown" }
        return "\(count) tracks"
    }
}

private struct MainWorkflowView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SessionCard().disabled(model.isApplying)
                RecordingProfileCard().disabled(model.isApplying)
                EditSessionCard().disabled(model.isApplying)
                ApplyCard()
                DiagnosticsExportButton()
            }
            .padding(20)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct SessionCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Card(title: "Session") {
            HStack(spacing: 18) {
                StatView(label: "Current", value: model.currentSessionName.isEmpty ? L.text("Unknown") : model.currentSessionName)
                StatView(label: "Tracks", value: model.currentTrackCount.map(String.init) ?? "-")
                StatView(label: "Expected Apply Session", value: model.expectedSessionName)
            }
            HStack {
                TextField(L.text("Expected session before apply"), text: $model.expectedSessionName)
                    .textFieldStyle(.roundedBorder)
                Button {
                    model.checkCurrentSession()
                } label: {
                    Label(L.text("Refresh Session"), systemImage: "arrow.clockwise")
                }
                .disabled(model.isRunning)
            }
        }
    }
}

struct NewProfileButton: View {
    @EnvironmentObject private var model: AppModel
    @State private var isConfirmingNewProfile = false

    var body: some View {
        Button {
            if !model.songName.isEmpty || !model.recordingSessionName.isEmpty || !model.recordingGroups.isEmpty {
                isConfirmingNewProfile = true
            } else {
                model.newRecordingProfile()
            }
        } label: {
            Label(L.text("New Profile"), systemImage: "plus")
        }
        .disabled(model.isRunning)
        .help(L.text("Start a new Recording Profile"))
        .alert(L.text("Start a New Profile?"), isPresented: $isConfirmingNewProfile) {
            Button(L.text("Cancel"), role: .cancel) {}
            Button(L.text("New Profile")) { model.newRecordingProfile() }
        } message: {
            Text(L.text("Saved profiles will be kept. Unsaved changes to the current profile will be discarded. Save or update it first if you want to keep those changes."))
        }
    }
}

private struct RecordingProfileCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Card(title: "Recording Profile") {
            HStack(spacing: 10) {
                NewProfileButton()

                Picker(L.text("Saved Profile"), selection: $model.selectedProfileID) {
                    Text(L.text("Choose a saved profile")).tag(nil as UUID?)
                    ForEach(model.availableProfiles) { profile in
                        Text(L.text("\(profile.songName)  ·  \(profile.groupCount) groups"))
                            .tag(Optional(profile.id))
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity)

                Button {
                    if let id = model.selectedProfileID {
                        model.loadRecordingProfile(id)
                    }
                } label: {
                    Label(L.text("Load Profile"), systemImage: "folder.badge.gearshape")
                }
                .disabled(model.isRunning || model.selectedProfileID == nil)

                Button {
                    model.refreshRecordingProfiles()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help(L.text("Refresh Recording Profiles"))
                .disabled(model.isRunning)

                Button {
                    model.openProfileLibrary()
                } label: {
                    Image(systemName: "folder")
                }
                .help(L.text("Open Profile Library"))
            }

            Divider()

            HStack(alignment: .bottom, spacing: 12) {
                LabeledTextField("Song Name", text: $model.songName)

                Button {
                    model.exportRecordingSession()
                } label: {
                    Label(L.text("Export Recording Session"), systemImage: "square.and.arrow.down")
                }
                .disabled(model.isRunning)

                Button {
                    model.saveRecordingProfile()
                } label: {
                    Label(L.text(model.selectedProfileFolderPath.isEmpty ? "Save Profile" : "Update Profile"), systemImage: "externaldrive.badge.checkmark")
                }
                .disabled(model.isRunning || model.recordingTracks.isEmpty)

                Button {
                    model.openProfileFolder()
                } label: {
                    Image(systemName: "folder")
                }
                .help(L.text("Open Current Profile Folder"))
                .disabled(model.selectedProfileFolderPath.isEmpty)
            }

            HStack(spacing: 12) {
                SummaryBox(title: "Recording Session", summary: model.recordingSummary)
                ProfileStatusBox(
                    groups: model.recordingGroups.count,
                    files: model.profileSourceFiles.count,
                    missingFiles: model.missingProfileSourceFileCount,
                    isSaved: !model.selectedProfileFolderPath.isEmpty
                )
            }

            GroupToolbar()

            if let groupID = model.selectedRecordingGroupID,
               let group = model.recordingGroups.first(where: { $0.id == groupID }) {
                RecordingGroupEditor(group: group)
            } else {
                ContentUnavailableView(
                    L.text("No Recording Group"),
                    systemImage: "rectangle.stack.badge.plus",
                    description: Text(L.text("Export a Recording Session, then add a group."))
                )
                .frame(maxWidth: .infinity, minHeight: 130)
            }
        }
    }
}

private struct GroupToolbar: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            Text(L.text("Recording Groups"))
                .font(.headline)

            Picker(L.text("Recording Group"), selection: $model.selectedRecordingGroupID) {
                ForEach(model.recordingGroups) { group in
                    Text(L.text("\(group.name)  ·  \(group.targetTracks.count) tracks"))
                        .tag(Optional(group.id))
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity)
            .disabled(model.recordingGroups.isEmpty)

            Button {
                model.addRecordingGroup()
            } label: {
                Image(systemName: "plus")
            }
            .help(L.text("Add Recording Group"))
            .disabled(model.isRunning || model.recordingTracks.isEmpty)
        }
    }
}

private struct RecordingGroupEditor: View {
    @EnvironmentObject private var model: AppModel
    let group: RecordingGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom, spacing: 12) {
                LabeledTextField("Group Name", text: model.groupNameBinding(for: group.id))

                VStack(alignment: .leading, spacing: 4) {
                    Text(L.text("Recording Mockup Reference"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Picker(L.text("Recording Mockup Reference"), selection: model.recordingReferenceBinding(for: group.id)) {
                        Text(L.text("Choose a track")).tag("")
                        ForEach(model.recordingTracks) { track in
                            Text("\(track.name)  ·  \(L.text(track.formatLabel))").tag(track.name)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: .infinity)
                }

                Button(role: .destructive) {
                    model.removeRecordingGroup(group.id)
                } label: {
                    Image(systemName: "trash")
                }
                .help(L.text("Delete Recording Group"))
                .disabled(model.isRunning || model.recordingGroups.count == 1)
            }

            GroupTargetTrackPicker(group: group)
        }
        .padding(.top, 2)
    }
}

private struct EditSessionCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Card(title: "Edit Session") {
            HStack(spacing: 12) {
                Button {
                    model.exportEditSession()
                } label: {
                    Label(L.text("Export Edit Session"), systemImage: "square.and.arrow.down.on.square")
                }
                .disabled(model.isRunning)

                Text(model.editSessionName.isEmpty ? L.text("No Edit Session exported") : model.editSessionName)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Spacer()

                Text(L.text("\(model.enabledEditGroupCount) of \(model.recordingGroups.count) groups enabled"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            SummaryBox(title: "Edit Session", summary: model.editSummary)

            if model.recordingGroups.isEmpty {
                ContentUnavailableView(
                    L.text("No Recording Profile"),
                    systemImage: "folder.badge.questionmark",
                    description: Text(L.text("Load a saved Recording Profile first."))
                )
                .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                VStack(spacing: 0) {
                    ForEach(model.recordingGroups) { group in
                        EditGroupRow(group: group)
                        if group.id != model.recordingGroups.last?.id {
                            Divider()
                        }
                    }
                }
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay {
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                }
            }
        }
    }
}

private struct EditGroupRow: View {
    @EnvironmentObject private var model: AppModel
    let group: RecordingGroup

    private var isEnabled: Bool {
        model.editGroupSelections.first { $0.groupID == group.id }?.isEnabled == true
    }

    var body: some View {
        HStack(spacing: 12) {
            Toggle(L.text(""), isOn: model.editGroupEnabledBinding(for: group.id))
                .labelsHidden()
                .toggleStyle(.checkbox)

            VStack(alignment: .leading, spacing: 2) {
                Text(group.name)
                    .font(.headline)
                Text(L.text("Reference: \(group.recordingReferenceTrack.isEmpty ? "Not set" : group.recordingReferenceTrack)  ·  \(group.targetTracks.count) Recorded Tracks"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(width: 300, alignment: .leading)

            EditedDemoTrackPicker(
                tracks: model.editTracks,
                selection: model.editDemoBinding(for: group.id),
                prioritizedTrackNames: model.selectedEditTrackNames,
                isRefreshing: model.isRefreshingSelectedEditTracks,
                onOpen: model.refreshSelectedEditTracks
            )
            .frame(maxWidth: .infinity)
            .disabled(!isEnabled || model.editTracks.isEmpty || model.isRunning)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 58)
    }
}

private struct EditedDemoTrackPicker: View {
    @EnvironmentObject private var localizationModel: AppModel
    let tracks: [PTSLResponse.Body.Track]
    @Binding var selection: String
    let prioritizedTrackNames: Set<String>
    let isRefreshing: Bool
    let onOpen: () async -> Void
    @State private var isPresented = false
    @State private var searchText = ""

    private var orderedTracks: [PTSLResponse.Body.Track] {
        let prioritized = tracks.filter { prioritizedTrackNames.contains($0.name) }
        let remaining = tracks.filter { !prioritizedTrackNames.contains($0.name) }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let ordered = prioritized + remaining
        guard !query.isEmpty else { return ordered }
        return ordered.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || ($0.parent_folder_name?.localizedCaseInsensitiveContains(query) == true)
        }
    }

    var body: some View {
        Button {
            Task {
                await onOpen()
                searchText = ""
                isPresented = true
            }
        } label: {
            HStack {
                Text(selection.isEmpty ? L.text("Choose Edited Demo Track") : selection)
                    .foregroundStyle(selection.isEmpty ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.bordered)
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            VStack(spacing: 8) {
                TextField(L.text("Search Edit tracks"), text: $searchText)
                    .textFieldStyle(.roundedBorder)

                ScrollView {
                    LazyVStack(spacing: 1) {
                        ForEach(orderedTracks) { track in
                            Button {
                                selection = track.name
                                isPresented = false
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: selection == track.name ? "checkmark" : "")
                                        .frame(width: 14)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(track.name)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                        if let folder = track.parent_folder_name, !folder.isEmpty {
                                            Text(folder)
                                                .font(.caption2)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    Text(L.text(track.formatLabel))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .foregroundStyle(prioritizedTrackNames.contains(track.name) ? Color.red : Color.primary)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 5)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(width: 420, height: 320)
            }
            .padding(10)
        }
    }
}

private struct ManifestCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Card(title: "Conform Setup") {
            Grid(horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    LabeledTextField("Project", text: $model.projectName)
                    LabeledTextField("Sample Rate", text: $model.sampleRate)
                }
                GridRow {
                    LabeledTextField("Cue ID Prefix", text: $model.cueId)
                        .gridCellColumns(2)
                }
            }

            Button {
                model.saveManifest()
            } label: {
                Label(L.text("Save Conform Setup"), systemImage: "doc.badge.gearshape")
            }
            .disabled(model.isRunning || model.enabledEditGroupCount == 0)
        }
    }
}

private struct GroupTargetTrackPicker: View {
    @EnvironmentObject private var model: AppModel
    let group: RecordingGroup
    @State private var searchText = ""
    @State private var selectionAnchor: String?

    private var filteredTracks: [PTSLResponse.Body.Track] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let available = model.recordingTracks.filter { $0.name != group.recordingReferenceTrack }
        guard !query.isEmpty else { return available }
        return available.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || ($0.parent_folder_name?.localizedCaseInsensitiveContains(query) == true)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L.text("Recorded Tracks"))
                        .font(.headline)
                    Text(L.text(selectionSummary))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                TextField(L.text("Search tracks"), text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 220)

                Button {
                    model.selectRecordingTracks(filteredTracks, groupID: group.id)
                    selectionAnchor = nil
                } label: {
                    Label(L.text("Select Results"), systemImage: "checkmark.square")
                }
                .disabled(model.isRunning || filteredTracks.isEmpty)

                Button {
                    model.clearTargetTracks(groupID: group.id)
                    selectionAnchor = nil
                } label: {
                    Label(L.text("Clear"), systemImage: "xmark.square")
                }
                .disabled(model.isRunning || group.targetTracks.isEmpty)
            }

            if model.recordingTracks.isEmpty {
                ContentUnavailableView(
                    L.text("No Recording Tracks"),
                    systemImage: "waveform.slash",
                    description: Text(L.text("Export the recording session to load its audio tracks."))
                )
                .frame(maxWidth: .infinity, minHeight: 150)
            } else {
                trackTable
            }
        }
    }

    private var trackTable: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Color.clear.frame(width: 20)
                Text(L.text("Recording Track")).frame(maxWidth: .infinity, alignment: .leading)
                Text(L.text("Format")).frame(width: 62, alignment: .leading)
                Text(L.text("State")).frame(width: 66, alignment: .leading)
                Text(L.text("Clips")).frame(width: 52, alignment: .leading)
                Text(L.text("Edit Destination")).frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)

            Divider()

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(filteredTracks) { track in
                        GroupTargetTrackRow(groupID: group.id, track: track) { selected, usesRange in
                            updateSelection(for: track, selected: selected, usesRange: usesRange)
                        }
                        Divider()
                    }
                }
            }
            .frame(height: min(CGFloat(max(filteredTracks.count, 1)) * 48, 320))
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay {
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
        }
        .onChange(of: model.recordingSessionName) {
            selectionAnchor = nil
        }
        .onChange(of: group.recordingReferenceTrack) {
            selectionAnchor = nil
        }
    }

    private func updateSelection(
        for track: PTSLResponse.Body.Track,
        selected: Bool,
        usesRange: Bool
    ) {
        if usesRange,
           let selectionAnchor,
           let anchorIndex = filteredTracks.firstIndex(where: { $0.name == selectionAnchor }),
           let trackIndex = filteredTracks.firstIndex(where: { $0.name == track.name }) {
            let bounds = min(anchorIndex, trackIndex)...max(anchorIndex, trackIndex)
            model.setTargetTracks(bounds.map { filteredTracks[$0] }, selected: selected, groupID: group.id)
        } else {
            model.setTargetTrack(track.name, selected: selected, groupID: group.id)
        }
        selectionAnchor = track.name
    }

    private var selectionSummary: String {
        let source = model.recordingSessionName.isEmpty ? "Recording session" : model.recordingSessionName
        let availableCount = model.recordingTracks.filter {
            $0.name != group.recordingReferenceTrack
        }.count
        return "\(source): \(group.targetTracks.count) of \(availableCount) selected"
    }
}

private struct GroupTargetTrackRow: View {
    @EnvironmentObject private var model: AppModel
    let groupID: UUID
    let track: PTSLResponse.Body.Track
    let onSelectionChange: (_ selected: Bool, _ usesRange: Bool) -> Void

    private var isSelected: Bool {
        model.isTargetTrackSelected(track.name, groupID: groupID)
    }

    private var isAssignedElsewhere: Bool {
        model.isTargetTrackAssignedElsewhere(track.name, groupID: groupID)
    }

    var body: some View {
        HStack(spacing: 10) {
            Toggle(L.text(""), isOn: Binding(
                get: { isSelected },
                set: { onSelectionChange($0, NSEvent.modifierFlags.contains(.shift)) }
            ))
            .labelsHidden()
            .toggleStyle(.checkbox)
            .frame(width: 20)
            .disabled(isAssignedElsewhere)

            VStack(alignment: .leading, spacing: 1) {
                Text(track.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let folder = track.parent_folder_name, !folder.isEmpty {
                    Text(folder)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if isAssignedElsewhere {
                    Text(L.text("Assigned to another group"))
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(L.text(track.formatLabel))
                .frame(width: 62, alignment: .leading)

            Text(L.text(track.isInactive ? "Inactive" : "Active"))
                .foregroundStyle(track.isInactive ? .secondary : .primary)
                .frame(width: 66, alignment: .leading)

            Image(systemName: track.containsClips ? "waveform" : "minus")
                .foregroundStyle(track.containsClips ? .primary : .tertiary)
                .frame(width: 52, alignment: .leading)
                .help(L.text(track.containsClips ? "Contains clips" : "No clips"))

            TextField(
                "Destination track",
                text: model.destinationBinding(for: track.name, groupID: groupID)
            )
            .textFieldStyle(.roundedBorder)
            .disabled(!isSelected || model.isRunning || isAssignedElsewhere)
            .frame(maxWidth: .infinity)
        }
        .font(.subheadline)
        .padding(.horizontal, 10)
        .frame(minHeight: 47)
        .contentShape(Rectangle())
    }
}

private struct ApplyCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Card(title: "Apply") {
            Text(L.text("New tracks are inserted below the lowest selected Pro Tools track, or at the bottom of the Session when no track is selected. If a destination name already exists, AutoEdit appends _2, _3, and so on before applying."))
                .foregroundStyle(.secondary)

            HStack {
                Toggle(L.text("Convert To Session Format"), isOn: Binding(
                    get: { model.convertToSessionFormat },
                    set: { model.setConvertToSessionFormat($0) }
                ))
                .toggleStyle(.checkbox)
                .disabled(model.isApplying)

                Toggle(L.text("Link Source Audio Files"), isOn: Binding(
                    get: { model.linkSourceAudioFiles },
                    set: { model.setLinkSourceAudioFiles($0) }
                ))
                .toggleStyle(.checkbox)
                .disabled(model.isApplying)
            }

            HStack {
                Button(role: .destructive) {
                    model.applyToCurrentEditSession()
                } label: {
                    Label(L.text("Apply"), systemImage: "square.and.arrow.down")
                }
                .disabled(model.isRunning || model.enabledEditGroupCount == 0 || model.editTracks.isEmpty)

                Button(L.text("Cancel"), role: .cancel) {
                    model.cancelApply()
                }
                .disabled(!model.isApplying)

                Text(L.text(model.isApplying ? model.status : "Checks run automatically before Apply."))
                    .foregroundStyle(.secondary)
            }

            if !model.workflowError.isEmpty {
                Text(L.error(model.workflowError)).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack(spacing: 12) {
                ApplySummaryBox(report: model.applyReport)
                SummaryBox(title: "Post Apply", summary: model.postApplySummary)
            }
        }
    }

}

private struct DiagnosticsExportButton: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button {
            model.exportDiagnostics()
        } label: {
            Label(L.text("Export Diagnostics…"), systemImage: "square.and.arrow.up")
        }
        .disabled(model.isRunning)
        .help(L.text("Save logs, plans and Session metadata as a ZIP; audio is not included."))
    }
}

private struct Card<Content: View>: View {
    @EnvironmentObject private var localizationModel: AppModel
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.text(title))
                .font(.title3.weight(.semibold))
            content
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct StatView: View {
    @EnvironmentObject private var localizationModel: AppModel
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L.text(label))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct LabeledTextField: View {
    @EnvironmentObject private var localizationModel: AppModel
    let label: String
    @Binding var text: String

    init(_ label: String, text: Binding<String>) {
        self.label = label
        self._text = text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L.text(label))
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField(L.text(label), text: $text)
                .textFieldStyle(.roundedBorder)
        }
    }
}

private struct SummaryBox: View {
    @EnvironmentObject private var localizationModel: AppModel
    let title: String
    let summary: SessionParseSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.text(title))
                .font(.headline)
            if let summary {
                Text(summary.sessionName ?? L.text("Unknown"))
                    .font(.subheadline.weight(.medium))
                Text(L.text("Tracks \(summary.tracks ?? 0), clips \(summary.onlineClips ?? 0), events \(summary.trackEvents ?? 0), warnings \(summary.warnings ?? 0)"))
                    .foregroundStyle(.secondary)
            } else {
                Text(L.text("Not exported"))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private struct ProfileStatusBox: View {
    @EnvironmentObject private var localizationModel: AppModel
    let groups: Int
    let files: Int
    let missingFiles: Int
    let isSaved: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.text("Profile"))
                .font(.headline)
            Text(L.text("\(groups) groups, \(files) referenced audio files"))
                .font(.subheadline.weight(.medium))
            if missingFiles > 0 {
                Label(L.text("\(missingFiles) audio files unavailable"), systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            } else {
                Text(L.text(isSaved ? "Saved in AutoEdit Library" : "Not saved yet"))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private struct ConformSummaryBox: View {
    @EnvironmentObject private var localizationModel: AppModel
    let plan: ConformPlan?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.text("Conform"))
                .font(.headline)
            if let summary = plan?.summary {
                Text(L.text("Clips \(summary.outputClipEntries ?? 0), gaps \(summary.gaps ?? 0), fades \(summary.transitions ?? 0)"))
                Text(L.text("Warnings \(summary.warnings ?? 0), offline files \(summary.diagnostics?.offlineSourceFiles ?? 0)"))
                    .foregroundStyle(.secondary)
            } else {
                Text(L.text("No dry-run"))
                    .foregroundStyle(.secondary)
            }
        }
        .summaryStyle()
    }
}

private struct CommandSummaryBox: View {
    @EnvironmentObject private var localizationModel: AppModel
    let plan: CommandPlan?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.text("Command"))
                .font(.headline)
            if let summary = plan?.summary {
                Text(L.text("Tracks \(summary.createTracks ?? 0), clip groups \(summary.clipGroups ?? 0), fade groups \(summary.fadeGroups ?? 0)"))
                Text(L.text("Fatal \(summary.fatalIssues ?? 0), warnings \(summary.warnings ?? 0)"))
                    .foregroundStyle(.secondary)
            } else {
                Text(L.text("No command plan"))
                    .foregroundStyle(.secondary)
            }
        }
        .summaryStyle()
    }
}

private struct PreflightSummaryBox: View {
    @EnvironmentObject private var localizationModel: AppModel
    let report: ApplyReport?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.text("Preflight"))
                .font(.headline)
            if let summary = report?.preflight?.summary {
                Text(L.text("Blockers \(summary.blockers ?? 0)"))
                Text(L.text("Fatal \(summary.fatalIssues ?? 0), warnings \(summary.warnings ?? 0)"))
                    .foregroundStyle(.secondary)
            } else {
                Text(L.text("Not checked"))
                    .foregroundStyle(.secondary)
            }
        }
        .summaryStyle()
    }
}

private struct ApplySummaryBox: View {
    @EnvironmentObject private var localizationModel: AppModel
    let report: ApplyReport?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.text("Apply"))
                .font(.headline)
            if let report {
                Text(L.text("Failed commands \(report.failedCommands ?? 0)"))
                Text(L.text(report.partial == true ? "Apply Partially Complete" : (report.execute == true ? "Executed" : "Preflight only")))
                    .foregroundStyle(.secondary)
            } else {
                Text(L.text("Not applied"))
                    .foregroundStyle(.secondary)
            }
        }
        .summaryStyle()
    }
}

private extension View {
    func summaryStyle() -> some View {
        self
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Color(nsColor: .windowBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private struct PositionApprovalView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L.text(model.isRuntimeApproval ? "Skip Issues — Approval Required" : "Review Issues — Approval Required")).font(.title2)
            Text(L.text(model.isRuntimeApproval
                ? "A new issue occurred. Review what will be skipped before continuing. Completed Pro Tools changes are retained."
                : "Review the affected tracks, clips and time ranges. No changes have been made to Pro Tools."))
            if !model.isRuntimeApproval, model.preflightReport?.preflight?.importAnyway != nil {
                Picker(L.text("Uncertain audio"), selection: $model.importUncertainAudio) {
                    Text(L.text("Skip affected clips")).tag(false)
                        .disabled(!(model.preflightReport?.preflight?.fatalIssues ?? []).isEmpty)
                    Text(L.text("Import audio for manual correction")).tag(true)
                }.pickerStyle(.radioGroup)
                Text(L.text(model.importUncertainAudio
                    ? "Import available audio and usable fades at the proposed positions. Confirm the selected reference relationship and review the listed issues. Unavailable files and invalid clips will still be skipped."
                    : "Affected clips will not be imported. Other clips will continue normally."))
                    .foregroundStyle(.secondary)
            }
            if !model.isRuntimeApproval, let summary = model.selectedApprovalPreflight?.summary {
                Text(L.text("Ready: \(summary.createTracks ?? 0) tracks, \(summary.clipGroups ?? 0) clip groups, \(summary.fadeGroups ?? 0) fade groups."))
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(model.displayedApprovalIssues.enumerated()), id: \.offset) { _, issue in
                        Text(L.issue(issue)).textSelection(.enabled)
                        if model.canLocateSource(issue) {
                            Button(L.text("Locate Source File…")) { model.locateSourceFile(issue) }
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 300)
            HStack {
                Spacer()
                Button(L.text("Cancel")) { model.answerPositionApproval(false) }.keyboardShortcut(.cancelAction)
                Button(L.text(!model.isRuntimeApproval && model.importUncertainAudio ? "Import and Continue"
                    : (!model.isRuntimeApproval && (model.selectedApprovalPreflight?.skipIssues ?? []).isEmpty
                        ? "Continue with available audio and fades" : "Skip Issues and Continue"))) { model.answerPositionApproval(true) }
                    .disabled(!model.isRuntimeApproval && !(model.selectedApprovalPreflight?.fatalIssues ?? []).isEmpty)
            }
        }.padding(24).frame(width: 620).interactiveDismissDisabled()
    }
}

private struct WorkflowResultView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L.text(model.applyResultTitle)).font(.title2)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(L.error(model.applyResultMessage)).textSelection(.enabled)
                    ForEach(Array(model.resultIssues.enumerated()), id: \.offset) { _, issue in
                        Text(L.issue(issue)).textSelection(.enabled)
                        if model.canLocateSource(issue) {
                            Button(L.text("Locate Source File…")) { model.locateSourceFile(issue) }
                        }
                    }
                    ForEach(model.plannedDestinationRenames, id: \.self) { rename in
                        Text(L.text("Destination names adjusted") + ": " + rename)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 400)
            HStack { Spacer(); Button(L.text("OK")) { model.isApplyResultPresented = false }.keyboardShortcut(.defaultAction) }
        }.padding(24).frame(width: 620)
    }
}
