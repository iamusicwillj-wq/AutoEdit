import { fadeTouchesClip } from './fadeDependencies.js';
function mediaPos(samples) {
  return { position: samples, time_type: "BTType_Samples" };
}

function timelineLocation(samples) {
  return { location: String(samples), time_type: "TLType_Samples" };
}

function formatForChannelCount(channelCount, prefix) {
  const formats = {
    1: "Mono",
    2: "Stereo",
    3: "LCR",
    4: "LCRS",
    5: "5_0",
    6: "5_1"
  };
  const name = formats[channelCount];
  return name ? `${prefix}_${name}` : "";
}

function groupKey(clip) {
  return [
    clip.destinationTrack,
    clip.timelineStartSamples,
    clip.timelineEndSamples,
    clip.sourceFilePath || clip.sourceFile,
    clip.sourceStartSamples,
    clip.sourceEndSamples,
    Boolean(clip.isMuted)
  ].join("|");
}

function transitionGroupKey(transition) {
  return [
    transition.type,
    transition.destinationTrack,
    transition.timelineStartSamples,
    transition.timelineEndSamples,
    transition.timelineEditBoundarySamples,
    transition.fadePresetName ?? ""
  ].join("|");
}

function clipBaseName(clip, index) {
  const cuePrefix = clip.cueId ? `${clip.cueId}_` : "";
  return `${cuePrefix}${clip.destinationTrack}_${String(index + 1).padStart(3, "0")}`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

function stemChannelId(channel, channelCount) {
  if (channelCount === 1) {
    return { name: "SChannel_Mono" };
  }
  if (channelCount === 2) {
    return {
      name: channel === 1 ? "SChannel_Left" : "SChannel_Right"
    };
  }
  return { index: channel };
}

export function buildCommandPlan(conformPlan) {
  const issuesByMessage = new Map();
  const trackChannels = new Map();
  const importsByPath = new Map();
  const groups = new Map();
  const transitionGroups = new Map();

  function addIssue(severity, code, message, details = {}) {
    issuesByMessage.set(`${message}|${details.destinationTrack ?? ""}|${details.channel ?? ""}|${details.timelineStartSamples ?? ""}|${details.timelineEndSamples ?? ""}`, { ...details, severity, code, message });
  }

  for (const issue of conformPlan.fadeDiagnostics ?? []) {
    if (["fatal", "review"].includes(issue.severity)) addIssue(issue.severity, issue.code, issue.message, issue);
  }

  for (const gap of conformPlan.gaps ?? []) {
    addIssue("warning", "position-gap",
      `${gap.destinationTrack}: no recorded coverage at samples ${gap.timelineStartSamples}–${gap.timelineEndSamples}. This interval will remain empty; existing clips will not move.`,
      {...gap,durationSeconds:gap.durationSamples/conformPlan.sampleRate});
  }
  for (const issue of conformPlan.mappingDiagnostics ?? []) {
    addIssue(issue.severity, issue.code, issue.message, issue);
  }
  const mappedMessages = new Set((conformPlan.mappingDiagnostics ?? []).map(i => i.message));
  for (const message of conformPlan.warnings ?? []) {
    if (mappedMessages.has(message)) continue;
    // Unstructured mapping warnings need investigation, not blanket approval.
    const destinations = (conformPlan.cues ?? []).filter(c=>(c.warnings??[]).includes(message)).flatMap(c=>c.destinationTracks??[]);
    if(destinations.length) for(const destinationTrack of destinations) addIssue("fatal","conform-warning",message,{destinationTrack});
    else addIssue("fatal", "conform-warning", message);
  }

  const requestedTargetTracks = conformPlan.summary?.requestedTargetTracks
    ?? (conformPlan.cues ?? []).reduce(
      (sum, cue) => sum + (cue.requestedTargetTracks ?? 0),
      0
    );
  if (requestedTargetTracks > 0 && (conformPlan.clips ?? []).length === 0) {
    const hasMappedGaps = (conformPlan.gaps ?? []).length > 0;
    addIssue(
      "fatal",
      "empty-conform-plan",
      hasMappedGaps
        ? `The ${requestedTargetTracks} selected Recorded Track(s) contain no audio overlapping the Edited Demo ranges.`
        : `Conform produced no clips for ${requestedTargetTracks} selected target track(s).`
    );
  }

  for (const clip of conformPlan.clips ?? []) {
    const scope = { destinationTrack: clip.destinationTrack, timelineStartSamples: clip.timelineStartSamples,
      timelineEndSamples: clip.timelineEndSamples, sourcePath: clip.sourceFilePath, clipName: clip.demoClipName };
    if (!clip.sourceFilePath) {
      addIssue(
        "fatal",
        "missing-source-file-path",
        `Missing sourceFilePath for clip ${clip.sourceClipName}; apply will need import path resolution.`, scope
      );
    } else {
      importsByPath.set(clip.sourceFilePath, {
        path: clip.sourceFilePath,
        sourceFile: clip.sourceFile
      });
    }
    if (clip.sourceFileOnline === false) {
      addIssue(
        "fatal",
        "offline-source-file",
        `Source file is offline for clip ${clip.sourceClipName}: ${clip.sourceFilePath || clip.sourceFile}`, scope
      );
    }
    if (clip.sourceClipOnline === false) {
      addIssue("fatal", "offline-source-clip", `Source clip is offline: ${clip.sourceClipName}`, scope);
    }
    if (clip.sourceTrackInactive) {
      addIssue("warning", "inactive-source-track", `Source track is inactive: ${clip.sourceTrack}`, {sourceTrack: clip.sourceTrack});
    }

    const channels = trackChannels.get(clip.destinationTrack) ?? new Set();
    channels.add(clip.channel);
    trackChannels.set(clip.destinationTrack, channels);

    const key = groupKey(clip);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        cueId: clip.cueId,
        destinationTrack: clip.destinationTrack,
        sourceFile: clip.sourceFile,
        sourceFilePath: clip.sourceFilePath,
        timelineStartSamples: clip.timelineStartSamples,
        timelineEndSamples: clip.timelineEndSamples,
        sourceStartSamples: clip.sourceStartSamples,
        sourceEndSamples: clip.sourceEndSamples,
        isMuted: Boolean(clip.isMuted),
        channels: []
      });
    }
    groups.get(key).channels.push({
      channel: clip.channel,
      sourceChannel: clip.sourceChannel ?? clip.channel,
      sourceClipName: clip.sourceClipName,
      sourceFileId: clip.sourceFileId,
      sourceClipId: clip.sourceClipId
    });
  }

  for (const transition of conformPlan.transitions ?? []) {
    if (!["crossfade", "fade-in", "fade-out"].includes(transition.type)) {
      continue;
    }
    const key = transitionGroupKey(transition);
    if (!transitionGroups.has(key)) {
      const fadePresetName = transition.fadePresetName ?? "";
      transitionGroups.set(key, {
        key,
        cueId: transition.cueId,
        type: transition.type,
        destinationTrack: transition.destinationTrack,
        sourceTrack: transition.sourceTrack,
        timelineStartSamples: transition.timelineStartSamples,
        timelineEndSamples: transition.timelineEndSamples,
        timelineEditBoundarySamples: transition.timelineEditBoundarySamples,
        recordingStartSamples: transition.recordingStartSamples,
        recordingEndSamples: transition.recordingEndSamples,
        recordingEditBoundarySamples: transition.recordingEditBoundarySamples,
        fadePresetName,
        channels: [],
        selectTracksByNameRequest: {
          track_names: [transition.destinationTrack],
          selection_mode: "SMode_Replace",
          pagination_request: { limit: 100, offset: 0 }
        },
        setTimelineSelectionRequest: {
          in_time: String(transition.timelineStartSamples),
          out_time: String(transition.timelineEndSamples),
          location_type: "TLType_Samples"
        },
        createFadesBasedOnPresetRequest: {
          ...(fadePresetName ? { fade_preset_name: fadePresetName } : {}),
          auto_adjust_bounds: true
        }
      });
    }
    transitionGroups.get(key).channels.push({
      channel: transition.channel,
      leftClipName: transition.leftClipName,
      rightClipName: transition.rightClipName
    });
  }

  const createTracks = [...trackChannels.entries()].map(([trackName, channels]) => {
    const channelCount = channels.size;
    const trackFormat = formatForChannelCount(channelCount, "TFormat");
    if (!trackFormat) {
      addIssue(
        "fatal",
        "unsupported-track-channel-count",
        `Unsupported destination track channel count ${channelCount} for ${trackName}.`, {destinationTrack: trackName}
      );
    }
    return {
      track_name: trackName,
      number_of_tracks: 1,
      track_format: trackFormat || "TFormat_Mono",
      track_type: "TType_Audio",
      track_timebase: "TTimebase_Samples",
      channel_count: channelCount
    };
  });

  const clipGroups = [...groups.values()]
    .sort((a, b) => a.timelineStartSamples - b.timelineStartSamples || a.destinationTrack.localeCompare(b.destinationTrack))
    .map((group, index) => {
      group.channels.sort((a, b) => a.channel - b.channel);
      const channelCount = uniqueSorted(group.channels.map((channel) => channel.channel)).length;
      const stemFormat = formatForChannelCount(channelCount, "SFormat");
      if (!stemFormat) {
        addIssue(
          "fatal",
          "unsupported-clip-channel-count",
          `Unsupported clip channel count ${channelCount} for ${group.destinationTrack} at ${group.timelineStartSamples}.`, {destinationTrack: group.destinationTrack, timelineStartSamples:group.timelineStartSamples,timelineEndSamples:group.timelineEndSamples}
        );
      }

      const createAudioClipRequest = {
        clip_list: [
          {
            name: clipBaseName(group, index),
            channel_format: stemFormat || "SFormat_Mono",
            clip_info: group.channels.map((channel) => ({
              file_id_ref: group.sourceFilePath || group.sourceFile,
              src_channel: stemChannelId(channel.sourceChannel, channelCount),
              dst_channel: stemChannelId(channel.channel, channelCount),
              src_start_point: mediaPos(group.sourceStartSamples),
              src_end_point: mediaPos(group.sourceEndSamples)
            }))
          }
        ]
      };

      return {
        ...group,
        name: clipBaseName(group, index),
        channelCount,
        createAudioClipRequest,
        spotClipsByIdRequest: {
          src_clips_ref: `created:${clipBaseName(group, index)}`,
          dst_track_name: group.destinationTrack,
          clip_instance_attributes: { is_muted: group.isMuted },
          dst_location_data: {
            location_type: "SLType_Start",
            location: timelineLocation(group.timelineStartSamples)
          }
        }
      };
    });

  const fadeGroups = [...transitionGroups.values()]
    .sort((a, b) => {
      return a.timelineStartSamples - b.timelineStartSamples
        || a.destinationTrack.localeCompare(b.destinationTrack);
    })
    .map((group) => ({
      ...group,
      channels: group.channels.sort((a, b) => a.channel - b.channel),
      requiredClipNames: clipGroups.filter(c=>fadeTouchesClip(group,c)).map(c=>c.name)
    }));

  // Keep every diagnostic in the conform report, but present the same missing
  // interval only once when both audio coverage and fade coverage report it.
  const allIssues = [...issuesByMessage.values()];
  const issues = allIssues.filter(i=>i.code!=='reference-fade-coverage' || !allIssues.some(g=>
    g.code==='position-gap' && g.destinationTrack===i.destinationTrack
    && g.timelineStartSamples<=i.timelineStartSamples && g.timelineEndSamples>=i.timelineEndSamples));
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const fatalIssues = issues.filter((issue) => issue.severity === "fatal");

  return {
    project: conformPlan.project,
    sampleRate: conformPlan.sampleRate,
    summary: {
      imports: importsByPath.size,
      createTracks: createTracks.length,
      clipGroups: clipGroups.length,
      fadeGroups: fadeGroups.length,
      channelClipEntries: (conformPlan.clips ?? []).length,
      transitionEntries: (conformPlan.transitions ?? []).length,
      warnings: warnings.length,
      fatalIssues: fatalIssues.length
    },
    imports: [...importsByPath.values()],
    createTracks,
    clipGroups,
    fadeGroups,
    issues,
    reviewNotes: [...new Set((conformPlan.fadeDiagnostics ?? []).filter(d => d.severity === "review").map(d => d.message))],
    warnings: warnings.map((issue) => issue.message),
    fatalIssues: fatalIssues.map((issue) => issue.message)
  };
}
