import { remainingFadeGaps, repairFadeCoverage, recordingHandleLimits } from "./fadeRepair.js";
import { findTrack } from "./sessionInfoParser.js";

function asArray(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function sampleValue(value, fallback = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected sample value, got: ${value}`);
  }
  return parsed;
}

function referenceTimelineForTrack(session, trackName, options) {
  const events = trackEventsForConform(session, trackName, { ...options, includeFades: true });
  // GetClipList's source start includes hidden fade handles, whereas the EDL
  // audio interval excludes them. Normalize both sides of the correspondence
  // before deriving an offset, just as for edited and recorded audio. Reference
  // fades establish sample positions; they are not copied to the destination.
  return [...eventsByChannel(events).values()]
    .flatMap(channel => normalizeAudioForFades(channel, { expandStandaloneFades: true }))
    .filter(event => event.type === "audio")
    .sort((a, b) => a.timelineStartSamples - b.timelineStartSamples || a.channel - b.channel);
}

function cloneEvent(event) {
  return { ...event };
}

function trackEventsForConform(session, trackName, {
  includeMuted = false,
  includeHidden = true,
  includeInactive = true,
  includeFades = false,
  channel = null
} = {}) {
  const track = findTrack(session, trackName);
  if (!track || (!includeHidden && track.isHidden) || (!includeInactive && track.isInactive)) {
    return [];
  }
  return track.events
    .filter((event) => {
      if (!includeFades && event.isFade) {
        return false;
      }
      if (!includeMuted && event.isMuted) {
        return false;
      }
      if (channel !== null && event.channel !== channel) {
        return false;
      }
      return event.timelineStartSamples !== null && event.timelineEndSamples !== null;
    })
    .map(cloneEvent)
    .sort((a, b) => a.timelineStartSamples - b.timelineStartSamples || a.channel - b.channel || a.event - b.event);
}

function eventsByChannel(events) {
  const byChannel = new Map();
  for (const event of events) {
    const channelEvents = byChannel.get(event.channel) ?? [];
    channelEvents.push(event);
    byChannel.set(event.channel, channelEvents);
  }
  for (const channelEvents of byChannel.values()) {
    channelEvents.sort((a, b) => a.timelineStartSamples - b.timelineStartSamples || a.event - b.event);
  }
  return byChannel;
}

function eventDuration(event) {
  return event.durationSamples ?? event.timelineEndSamples - event.timelineStartSamples;
}

function clipListSourceStart(event) {
  return event.clipListSourceStartSamples ?? event.sourceStartSamples;
}

function clipListSourceEnd(event) {
  return event.clipListSourceEndSamples ?? event.sourceEndSamples;
}

function adjacentCrossfadeBefore(channelEvents, index, event) {
  const previous = channelEvents[index - 1];
  return previous?.type === "crossfade" && previous.timelineEndSamples === event.timelineStartSamples
    ? previous
    : null;
}

function adjacentCrossfadeAfter(channelEvents, index, event) {
  const next = channelEvents[index + 1];
  return next?.type === "crossfade" && next.timelineStartSamples === event.timelineEndSamples
    ? next
    : null;
}

function adjacentFadeInBefore(channelEvents, index, event) {
  const previous = channelEvents[index - 1];
  return previous?.type === "fade-in" && previous.timelineEndSamples === event.timelineStartSamples
    ? previous
    : null;
}

function adjacentFadeOutAfter(channelEvents, index, event) {
  const next = channelEvents[index + 1];
  return next?.type === "fade-out" && next.timelineStartSamples === event.timelineEndSamples
    ? next
    : null;
}

function hiddenHandleSamples(event) {
  const sourceStart = clipListSourceStart(event);
  const sourceEnd = clipListSourceEnd(event);
  const visibleDuration = eventDuration(event);
  if (sourceStart === null || sourceEnd === null || visibleDuration === null) {
    return 0;
  }
  return Math.max(0, sourceEnd - sourceStart - visibleDuration);
}

function allocateHiddenHandles(channelEvents) {
  const allocations = new Map();
  let previousAudioAllocation = null;

  for (let index = 0; index < channelEvents.length; index += 1) {
    const event = channelEvents[index];
    if (event.type !== "audio") {
      continue;
    }

    const previousCrossfade = adjacentCrossfadeBefore(channelEvents, index, event);
    const nextCrossfade = adjacentCrossfadeAfter(channelEvents, index, event);
    const previousFadeIn = adjacentFadeInBefore(channelEvents, index, event);
    const nextFadeOut = adjacentFadeOutAfter(channelEvents, index, event);
    const hiddenSamples = hiddenHandleSamples(event);
    const requestedPrefixSamples = previousFadeIn
      ? eventDuration(previousFadeIn)
      : previousCrossfade && previousAudioAllocation
        ? eventDuration(previousCrossfade) - previousAudioAllocation.hiddenSuffixSamples
        : 0;
    const hiddenPrefixSamples = Math.min(hiddenSamples, Math.max(0, requestedPrefixSamples));
    const remainingSamples = hiddenSamples - hiddenPrefixSamples;
    const requestedSuffixSamples = nextFadeOut
      ? eventDuration(nextFadeOut)
      : nextCrossfade
        ? eventDuration(nextCrossfade)
        : 0;
    const hiddenSuffixSamples = Math.min(remainingSamples, requestedSuffixSamples);
    // A prefix is determined by the preceding verified allocation. Unused
    // tail samples cannot change it when this occurrence has no next crossfade.
    const prefixVerified = !event.mappingUnverified && (!previousCrossfade
      || previousAudioAllocation?.allocationVerified === true);
    const allocationVerified = prefixVerified && (!nextCrossfade
      || hiddenSamples === hiddenPrefixSamples + hiddenSuffixSamples);
    const allocation = { hiddenPrefixSamples, hiddenSuffixSamples, allocationVerified };
    allocations.set(index, allocation);
    previousAudioAllocation = allocation;
  }

  return allocations;
}

function normalizeAudioForFades(channelEvents, { expandStandaloneFades = false } = {}) {
  const hiddenHandlesByIndex = allocateHiddenHandles(channelEvents);
  return channelEvents.map((event, index) => {
    if (event.type !== "audio") {
      return event;
    }

    const previousCrossfade = adjacentCrossfadeBefore(channelEvents, index, event);
    const nextCrossfade = adjacentCrossfadeAfter(channelEvents, index, event);
    const previousFadeIn = adjacentFadeInBefore(channelEvents, index, event);
    const nextFadeOut = adjacentFadeOutAfter(channelEvents, index, event);
    const { hiddenPrefixSamples, hiddenSuffixSamples } = hiddenHandlesByIndex.get(index);
    const sourceStart = clipListSourceStart(event);
    const sourceEnd = clipListSourceEnd(event);
    const expandedPrefixSamples = previousCrossfade || (expandStandaloneFades && previousFadeIn)
      ? hiddenPrefixSamples
      : 0;
    const expandedSuffixSamples = nextCrossfade || (expandStandaloneFades && nextFadeOut)
      ? hiddenSuffixSamples
      : 0;
    const visibleSourceStartSamples = sourceStart === null
      ? event.sourceStartSamples
      : sourceStart + hiddenPrefixSamples;
    const visibleSourceEndSamples = sourceEnd === null
      ? event.sourceEndSamples
      : sourceEnd - hiddenSuffixSamples;
    const effectiveStart = expandedPrefixSamples ? sourceStart ?? event.sourceStartSamples : visibleSourceStartSamples;
    const duration = eventDuration(event)+expandedPrefixSamples+expandedSuffixSamples;
    const allocationVerified = hiddenHandlesByIndex.get(index).allocationVerified;

    return {
      ...event,
      // A standalone fade fixes the source head independently of an unused
      // parent tail. Extra tail samples do not make that mapping ambiguous.
      mappingUnverified: Boolean(event.mappingUnverified || !allocationVerified),
      demoEventId: `${event.trackName}|${event.channel}|${index}`,
      visibleTimelineStartSamples: event.timelineStartSamples,
      visibleTimelineEndSamples: event.timelineEndSamples,
      visibleSourceStartSamples,
      visibleSourceEndSamples,
      clipFullSourceStartSamples: sourceStart,
      clipFullSourceEndSamples: sourceEnd,
      hiddenSourcePrefixSamples: hiddenPrefixSamples,
      hiddenSourceSuffixSamples: hiddenSuffixSamples,
      timelineStartSamples: event.timelineStartSamples - expandedPrefixSamples,
      timelineEndSamples: event.timelineEndSamples + expandedSuffixSamples,
      durationSamples: eventDuration(event) + expandedPrefixSamples + expandedSuffixSamples,
      sourceStartSamples: effectiveStart,
      // A longer parent clip is not permission to extend this occurrence past
      // the EDL interval. Keep a one-to-one sample mapping even for draft audio.
      sourceEndSamples: effectiveStart === null ? event.sourceEndSamples : effectiveStart+duration,
      sourceRangeBasis: hiddenPrefixSamples || hiddenSuffixSamples
        ? `${event.sourceRangeBasis}+fade_hidden_handles`
        : event.sourceRangeBasis
    };
  });
}

function crossfadeDescriptors(channelEvents) {
  const normalizedEvents = normalizeAudioForFades(channelEvents, { expandStandaloneFades: true });
  return channelEvents.flatMap((event, index) => {
    if (event.type !== "crossfade") {
      return [];
    }
    const left = normalizedEvents[index - 1]?.type === "audio" ? normalizedEvents[index - 1] : null;
    const right = normalizedEvents[index + 1]?.type === "audio" ? normalizedEvents[index + 1] : null;
    if (!left || !right) {
      return [];
    }
    const leftBoundary = left.timelineEndSamples;
    const rightBoundary = right.timelineStartSamples;
    const editBoundarySamples = leftBoundary === rightBoundary
      ? leftBoundary
      : Math.round((event.timelineStartSamples + event.timelineEndSamples) / 2);
    return [{
      event,
      left,
      right,
      editBoundarySamples
    }];
  });
}

function standaloneFadeDescriptors(channelEvents) {
  const normalizedEvents = normalizeAudioForFades(channelEvents, { expandStandaloneFades: true });
  return channelEvents.flatMap((event, index) => {
    if (event.type === "fade-in") {
      const audio = normalizedEvents[index + 1]?.type === "audio" ? normalizedEvents[index + 1] : null;
      return audio
        ? [{ event, audio, type: "fade-in" }]
        : [];
    }
    if (event.type === "fade-out") {
      const audio = normalizedEvents[index - 1]?.type === "audio" ? normalizedEvents[index - 1] : null;
      return audio
        ? [{ event, audio, type: "fade-out" }]
        : [];
    }
    return [];
  });
}

function buildCrossfadeTransitions(target, demoSegment, channelEvents, r0, r1) {
  const transitions = [];
  const normalizedEvents = normalizeAudioForFades(channelEvents);

  for (let index = 0; index < channelEvents.length; index += 1) {
    const event = channelEvents[index];
    if (event.type !== "crossfade") {
      continue;
    }

    const overlapStart = Math.max(r0, event.timelineStartSamples);
    const overlapEnd = Math.min(r1, event.timelineEndSamples);
    if (overlapStart >= overlapEnd) {
      continue;
    }

    const left = normalizedEvents[index - 1]?.type === "audio" ? normalizedEvents[index - 1] : null;
    const right = normalizedEvents[index + 1]?.type === "audio" ? normalizedEvents[index + 1] : null;
    const leftBoundary = left ? left.timelineEndSamples : null;
    const rightBoundary = right ? right.timelineStartSamples : null;
    const editBoundarySamples = leftBoundary !== null && rightBoundary !== null && leftBoundary === rightBoundary
      ? leftBoundary
      : Math.round((event.timelineStartSamples + event.timelineEndSamples) / 2);

    transitions.push({
      cueId: target.cueId,
      type: "crossfade",
      destinationTrack: target.destinationTrack,
      sourceTrack: target.sourceTrack,
      demoTrack: demoSegment.trackName,
      demoClipName: demoSegment.clipName,
      channel: event.channel,
      recordingStartSamples: event.timelineStartSamples,
      recordingEndSamples: event.timelineEndSamples,
      recordingEditBoundarySamples: editBoundarySamples,
      timelineStartSamples: demoSegment.timelineStartSamples + (event.timelineStartSamples - r0),
      timelineEndSamples: demoSegment.timelineStartSamples + (event.timelineEndSamples - r0),
      timelineEditBoundarySamples: demoSegment.timelineStartSamples + (editBoundarySamples - r0),
      durationSamples: eventDuration(event),
      overlapStartSamples: overlapStart,
      overlapEndSamples: overlapEnd,
      leftClipName: left?.clipName ?? "",
      rightClipName: right?.clipName ?? "",
      fadePresetName: target.fadePresetName ?? ""
    });
  }

  return transitions;
}

function recordingTimelineForTrack(session, trackName, options) {
  const events = trackEventsForConform(session, trackName, { ...options, includeFades: true });
  const channelEvents = [...eventsByChannel(events).values()].flatMap((events) => normalizeAudioForFades(events));
  return channelEvents.sort((a, b) => a.timelineStartSamples - b.timelineStartSamples || a.channel - b.channel);
}

function editTimelineForTrack(session, trackName, options) {
  const events = trackEventsForConform(session, trackName, { ...options, includeFades: true });
  const channelEvents = eventsByChannel(events).get(options.channel) ?? [];
  const normalizedEvents = normalizeAudioForFades(channelEvents, { expandStandaloneFades: true });
  return {
    segments: normalizedEvents.filter((event) => event.type === "audio"),
    crossfades: crossfadeDescriptors(channelEvents),
    standaloneFades: standaloneFadeDescriptors(channelEvents)
  };
}

function fadeFailure(target, event, channel, reason) {
  return { severity: "fatal", code: "unresolved-fade", type: event.type,
    destinationTrack: target.destinationTrack, channel,
    timelineStartSamples: event.timelineStartSamples, timelineEndSamples: event.timelineEndSamples,
    message: `${target.destinationTrack}, channel ${channel}, ${event.type} at samples ${event.timelineStartSamples}–${event.timelineEndSamples}: ${reason}` };
}

function buildEditCrossfadeTransitions(target, crossfades, targetClips, diagnostics, expectedChannels, recordingSegments) {
  const transitions = [];
  const channels = expectedChannels;

  for (const descriptor of crossfades) {
    const { event, left, right } = descriptor;
    const editBoundarySamples = descriptor.appliedEditBoundarySamples ?? descriptor.editBoundarySamples;
    for (const channel of channels) {
      const leftClip = targetClips.find((clip) =>
        clip.channel === channel && clip.demoEventId === left.demoEventId && clip.timelineEndSamples === editBoundarySamples
      );
      const rightClip = targetClips.find((clip) =>
        clip.channel === channel && clip.demoEventId === right.demoEventId && clip.timelineStartSamples === editBoundarySamples
      );
      if (!leftClip || !rightClip) {
        diagnostics.push(fadeFailure(target, event, channel, "Crossfade cannot cover both sides of the edit boundary; source handles are missing or unverified, or another take boundary is inside the fade."));
        continue;
      }
      // Preserve a useful crossfade when only an outer edge exceeds the real
      // source bounds. The cut and the source-to-timeline offsets stay fixed.
      const leftLimits = recordingHandleLimits(leftClip, recordingSegments);
      const rightLimits = recordingHandleLimits(rightClip, recordingSegments);
      const start = Math.max(event.timelineStartSamples, leftClip.timelineStartSamples,
        rightLimits.start, leftClip.fadeMappingStartSamples ?? -Infinity,
        rightClip.fadeMappingStartSamples ?? -Infinity);
      const end = Math.min(event.timelineEndSamples, rightClip.timelineEndSamples,
        leftLimits.end, leftClip.fadeMappingEndSamples ?? Infinity,
        rightClip.fadeMappingEndSamples ?? Infinity);
      if (!(start < end && start <= editBoundarySamples && editBoundarySamples <= end)) {
        diagnostics.push(fadeFailure(target, event, channel, "Crossfade cannot cover both sides of the edit boundary; source handles are missing or unverified, or another take boundary is inside the fade."));
        continue;
      }
      if (start !== event.timelineStartSamples || end !== event.timelineEndSamples) {
        diagnostics.push({...fadeFailure(target,event,channel,""),severity:'review',code:'shortened-fade',
          appliedStartSamples:start,appliedEndSamples:end,
          message:`${target.destinationTrack}, channel ${channel}: crossfade shortened from samples ${event.timelineStartSamples}–${event.timelineEndSamples} to ${start}–${end} to fit available recorded audio. Audio timing is unchanged; review this fade after Apply.`});
      }
      transitions.push({
        cueId: target.cueId,
        type: "crossfade",
        destinationTrack: target.destinationTrack,
        sourceTrack: target.sourceTrack,
        demoTrack: left.trackName,
        demoClipName: right.clipName,
        channel,
        recordingStartSamples: null,
        recordingEndSamples: null,
        recordingEditBoundarySamples: null,
        timelineStartSamples: start,
        timelineEndSamples: end,
        timelineEditBoundarySamples: editBoundarySamples,
        durationSamples: end-start,
        overlapStartSamples: start,
        overlapEndSamples: end,
        leftClipName: leftClip.sourceClipName,
        rightClipName: rightClip.sourceClipName,
        fadePresetName: target.fadePresetName ?? "",
        transitionBasis: "edit_demo_crossfade"
      });
    }
  }

  return transitions;
}

function buildEditStandaloneFadeTransitions(target, fades, targetClips, diagnostics, expectedChannels) {
  const transitions = [];
  const channels = expectedChannels;

  for (const { event: originalEvent, audio, type } of fades) {
    for (const channel of channels) {
      let event = originalEvent;
      let targetClip = targetClips.find((clip) => {
        if (clip.channel !== channel || clip.demoEventId !== audio.demoEventId) {
          return false;
        }
        return type === "fade-in"
          ? clip.timelineStartSamples === event.timelineStartSamples
            && clip.timelineEndSamples >= event.timelineEndSamples
          : clip.timelineEndSamples === event.timelineEndSamples
            && clip.timelineStartSamples <= event.timelineStartSamples;
      });
      if (!targetClip) {
        const pieces = targetClips.filter(c => c.channel === channel && c.demoEventId === audio.demoEventId)
          .sort((a,b) => a.timelineStartSamples - b.timelineStartSamples);
        const edgeClip = type === "fade-in" ? pieces[0] : pieces.at(-1);
        // Only shorten the outer edge. An internal take boundary still needs
        // special handling; never fade every fragment independently.
        const start = Math.max(originalEvent.timelineStartSamples, edgeClip?.timelineStartSamples ?? Infinity);
        const end = Math.min(originalEvent.timelineEndSamples, edgeClip?.timelineEndSamples ?? -Infinity);
        const coversInnerBoundary = type === "fade-in"
          ? edgeClip?.timelineEndSamples >= originalEvent.timelineEndSamples
          : edgeClip?.timelineStartSamples <= originalEvent.timelineStartSamples;
        if (start < end && coversInnerBoundary) {
          targetClip = edgeClip;
          event = { ...originalEvent, timelineStartSamples: start, timelineEndSamples: end, durationSamples: end-start };
          diagnostics.push({ ...fadeFailure(target, originalEvent, channel, ""),
            severity: "review", code: "shortened-fade",
            appliedStartSamples: start, appliedEndSamples: end,
            message: `${target.destinationTrack}, channel ${channel}: ${type} shortened from samples ${originalEvent.timelineStartSamples}–${originalEvent.timelineEndSamples} to ${start}–${end} to fit available recorded audio. Audio timing is unchanged; review this fade after Apply.`
          });
        }
      }
      if (!targetClip) {
        diagnostics.push(fadeFailure(target, event, channel, "Fade cannot span the recorded fragments: source handles are missing or unverified, or different takes interrupt the fade."));
        continue;
      }

      transitions.push({
        cueId: target.cueId,
        type,
        destinationTrack: target.destinationTrack,
        sourceTrack: target.sourceTrack,
        demoTrack: audio.trackName,
        demoClipName: audio.clipName,
        channel,
        recordingStartSamples: null,
        recordingEndSamples: null,
        recordingEditBoundarySamples: null,
        timelineStartSamples: event.timelineStartSamples,
        timelineEndSamples: event.timelineEndSamples,
        timelineEditBoundarySamples: type === "fade-in"
          ? event.timelineEndSamples
          : event.timelineStartSamples,
        durationSamples: eventDuration(event),
        overlapStartSamples: event.timelineStartSamples,
        overlapEndSamples: event.timelineEndSamples,
        leftClipName: type === "fade-out" ? targetClip.sourceClipName : "",
        rightClipName: type === "fade-in" ? targetClip.sourceClipName : "",
        fadePresetName: target.fadePresetName ?? "",
        transitionBasis: type === "fade-in" ? "edit_demo_fade_in" : "edit_demo_fade_out"
      });
    }
  }

  return transitions;
}

function sourceIdentity(event) {
  const sourceFile = String(event.sourceFile ?? "").trim().toLowerCase();
  if (sourceFile) {
    return `file:${sourceFile}`;
  }
  const sourcePath = String(event.sourceFilePath ?? "").trim().toLowerCase();
  const filename = sourcePath.split(/[/:\\]/).filter(Boolean).at(-1) ?? "";
  return filename ? `file:${filename}` : "";
}

function referenceTrackName(cue) {
  return cue.recording_reference_track
    ?? cue.recordingReferenceTrack
    ?? cue.recording_demo_track
    ?? cue.recordingDemoTrack
    ?? "";
}

function hasLegacyAnchorMapping(cue) {
  return [
    cue.edit_demo_anchor_samples,
    cue.editDemoAnchorSamples,
    cue.demo_anchor_samples,
    cue.demoAnchorSamples,
    cue.recording_anchor_samples,
    cue.recordingAnchorSamples
  ].some((value) => value !== undefined && value !== null && value !== "");
}

function mapEditSegmentThroughReference(demoSegment, referenceSegments) {
  const editSourceStart = demoSegment.sourceStartSamples;
  const editSourceEnd = demoSegment.sourceEndSamples;
  if (editSourceStart === null || editSourceEnd === null) {
    return [];
  }

  const demoIdentity = sourceIdentity(demoSegment);
  const referencesWithIdentity = referenceSegments.filter((segment) => sourceIdentity(segment));
  const identityMatches = referenceSegments.filter((segment) => sourceIdentity(segment) === demoIdentity);
  const uniqueReferenceIdentities = new Set(referencesWithIdentity.map(sourceIdentity));
  const candidates = identityMatches.length
    ? identityMatches
    : uniqueReferenceIdentities.size <= 1
      ? referenceSegments
      : [];

  return candidates.flatMap((referenceSegment) => {
    if (referenceSegment.sourceStartSamples === null || referenceSegment.sourceEndSamples === null) {
      return [];
    }
    // A uniquely placed reference establishes a sample offset, not a hard
    // recording boundary. Its trimmed head/tail must not discard real audio.
    // Multiple placements or uncertain metadata still use only their explicit
    // intervals. The user selects the corresponding reference tracks; a name
    // change between sessions is not a timing error.
    const extendReference = referenceSegments.length === 1 && !referenceSegment.mappingUnverified
      && !demoSegment.mappingUnverified
      && referenceSegment.sourceEndSamples-referenceSegment.sourceStartSamples
        === referenceSegment.timelineEndSamples-referenceSegment.timelineStartSamples;
    const referenceStart = extendReference ? 0 : referenceSegment.sourceStartSamples;
    const referenceEnd = extendReference
      ? Math.max(referenceSegment.sourceEndSamples, referenceSegment.sourceFileKnownEndSamples ?? 0)
      : referenceSegment.sourceEndSamples;
    const sourceStartSamples = Math.max(editSourceStart, referenceStart);
    const sourceEndSamples = Math.min(editSourceEnd, referenceEnd);
    if (sourceStartSamples >= sourceEndSamples) {
      return [];
    }

    const recordingStartSamples = referenceSegment.timelineStartSamples
      + (sourceStartSamples - referenceSegment.sourceStartSamples);
    const editTimelineStartSamples = demoSegment.timelineStartSamples
      + (sourceStartSamples - editSourceStart);
    return [{
      sourceStartSamples,
      sourceEndSamples,
      recordingStartSamples,
      recordingEndSamples: recordingStartSamples + (sourceEndSamples - sourceStartSamples),
      editTimelineStartSamples,
      editTimelineEndSamples: editTimelineStartSamples + (sourceEndSamples - sourceStartSamples),
      referenceClipName: referenceSegment.clipName,
      mappingUnverified: Boolean(referenceSegment.mappingUnverified),
      referenceMatchBasis: identityMatches.length ? 'source-name' : 'user-selected-reference',
      extendedReference: extendReference && (sourceStartSamples<referenceSegment.sourceStartSamples
        || sourceEndSamples>referenceSegment.sourceEndSamples),
      // Extra handles stay inside the reference's known source-media bounds.
      // Multiple placements use the narrower explicit occurrence bounds.
      fadeMappingStartSamples: !demoSegment.mappingUnverified && !referenceSegment.mappingUnverified
        && candidates.length === 1
        ? demoSegment.timelineStartSamples + referenceStart-editSourceStart : undefined,
      fadeMappingEndSamples: !demoSegment.mappingUnverified && !referenceSegment.mappingUnverified
        && candidates.length === 1
        ? demoSegment.timelineStartSamples + referenceEnd-editSourceStart : undefined,
      identityMatched: Boolean(demoIdentity && sourceIdentity(referenceSegment) === demoIdentity)
    }];
  }).sort((a, b) => a.sourceStartSamples - b.sourceStartSamples);
}

function pushGap(gaps, target, demoSegment, startInRecording, endInRecording, r0) {
  const timelineStartSamples = demoSegment.timelineStartSamples + (startInRecording - r0);
  const timelineEndSamples = timelineStartSamples + (endInRecording - startInRecording);
  gaps.push({
    cueId: target.cueId,
    destinationTrack: target.destinationTrack,
    sourceTrack: target.sourceTrack,
    demoTrack: demoSegment.trackName,
    demoClipName: demoSegment.clipName,
    demoEventId: demoSegment.demoEventId,
    recordingStartSamples: startInRecording,
    recordingEndSamples: endInRecording,
    timelineStartSamples,
    timelineEndSamples,
    durationSamples: endInRecording - startInRecording
  });
}

function buildClip(target, demoSegment, recordingSegment, overlapStart, overlapEnd, r0) {
  const durationSamples = overlapEnd - overlapStart;
  const sourceStartSamples = recordingSegment.sourceStartSamples
    + (overlapStart - recordingSegment.timelineStartSamples);
  const timelineStartSamples = demoSegment.timelineStartSamples + (overlapStart - r0);

  return {
    cueId: target.cueId,
    destinationTrack: target.destinationTrack,
    sourceTrack: target.sourceTrack,
    sourceFile: recordingSegment.sourceFile,
    sourceFilePath: recordingSegment.sourceFilePath ?? "",
    sourceFileId: recordingSegment.fileId ?? "",
    sourceFileOnline: recordingSegment.sourceFileOnline ?? null,
    sourceClipId: recordingSegment.clipId ?? "",
    sourceClipOnline: recordingSegment.clipIsOnline ?? null,
    sourceChannel: recordingSegment.sourceChannel,
    sourceClipName: recordingSegment.clipName,
    sourceTrackInactive: Boolean(recordingSegment.isOnInactiveTrack),
    demoTrack: demoSegment.trackName,
    demoClipName: demoSegment.clipName,
    demoTrackInactive: Boolean(demoSegment.isOnInactiveTrack),
    demoEventId: demoSegment.demoEventId,
    mappingTimelineStartSamples: demoSegment.timelineStartSamples,
    mappingTimelineEndSamples: demoSegment.timelineEndSamples,
    fadeMappingStartSamples: demoSegment.fadeMappingStartSamples,
    fadeMappingEndSamples: demoSegment.fadeMappingEndSamples,
    mappingUnverified: Boolean(demoSegment.mappingUnverified || recordingSegment.mappingUnverified),
    mappingEvidence: {
      referenceTrack:demoSegment.recordingReferenceTrack, referenceClip:demoSegment.recordingReferenceClipName,
      referenceMatchBasis:demoSegment.referenceMatchBasis,
      demoSourceStartSamples:demoSegment.sourceStartSamples, demoSourceEndSamples:demoSegment.sourceEndSamples,
      demoSourceRangeBasis:demoSegment.sourceRangeBasis,
      metadataResolution:demoSegment.clipMetadataResolution,
      metadataCandidates:demoSegment.clipMetadataCandidates
    },
    sourceFileKnownEndSamples: recordingSegment.sourceFileKnownEndSamples ?? null,
    isMuted: Boolean(demoSegment.isMuted),
    channel: recordingSegment.channel,
    sourceStartSamples,
    sourceEndSamples: sourceStartSamples + durationSamples,
    recordingStartSamples: overlapStart,
    recordingEndSamples: overlapEnd,
    timelineStartSamples,
    timelineEndSamples: timelineStartSamples + durationSamples,
    durationSamples,
    visibleRecordingStartSamples: recordingSegment.visibleTimelineStartSamples ?? recordingSegment.timelineStartSamples,
    visibleRecordingEndSamples: recordingSegment.visibleTimelineEndSamples ?? recordingSegment.timelineEndSamples,
    hiddenSourcePrefixSamples: recordingSegment.hiddenSourcePrefixSamples ?? 0,
    hiddenSourceSuffixSamples: recordingSegment.hiddenSourceSuffixSamples ?? 0,
    sourceRangeBasis: recordingSegment.sourceRangeBasis
  };
}

function targetTrackConfig(cue, targetTrack) {
  const sourceTrack = targetTrack.recording_source_track
    ?? targetTrack.recordingSourceTrack
    ?? targetTrack.source_track
    ?? targetTrack.sourceTrack
    ?? targetTrack.recording_track;
  return {
    cueId: cue.cue_id ?? cue.cueId ?? "",
    sourceTrack,
    destinationTrack: targetTrack.edit_destination_track
      ?? targetTrack.editDestinationTrack
      ?? targetTrack.destination_track
      ?? targetTrack.destinationTrack
      ?? sourceTrack,
    demoTracks: asArray(
      targetTrack.edit_demo_track
        ?? targetTrack.editDemoTrack
        ?? targetTrack.edit_demo_tracks
        ?? targetTrack.demo_track
        ?? targetTrack.demoTrack
        ?? targetTrack.demo_tracks
        ?? cue.edit_demo_track
        ?? cue.editDemoTrack
        ?? cue.edit_demo_tracks
        ?? cue.demo_track
        ?? cue.demoTrack
        ?? cue.demo_tracks
    ),
    includeMutedDemo: Boolean(targetTrack.include_muted_demo ?? cue.include_muted_demo ?? true),
    includeMutedRecording: Boolean(targetTrack.include_muted_recording ?? targetTrack.include_muted ?? true),
    includeHidden: targetTrack.include_hidden ?? cue.include_hidden ?? true,
    includeInactive: targetTrack.include_inactive ?? cue.include_inactive ?? true,
    demoChannel: targetTrack.demo_channel ?? targetTrack.demoChannel ?? cue.demo_channel ?? cue.demoChannel ?? 1,
    fadePresetName: targetTrack.fade_preset_name
      ?? targetTrack.fadePresetName
      ?? cue.fade_preset_name
      ?? cue.fadePresetName
      ?? ""
  };
}

export function conformCue({ cue, demoSession, recordingSession, partialPolicy = false }) {
  const cueId = cue.cue_id ?? cue.cueId ?? "";
  const usesReferenceMapping = Boolean(referenceTrackName(cue));
  const usesLegacyAnchors = !usesReferenceMapping && hasLegacyAnchorMapping(cue);
  const demoAnchor = usesLegacyAnchors ? sampleValue(
    cue.edit_demo_anchor_samples
      ?? cue.editDemoAnchorSamples
      ?? cue.demo_anchor_samples
      ?? cue.demoAnchorSamples,
    0
  ) : null;
  const recordingAnchor = usesLegacyAnchors
    ? sampleValue(cue.recording_anchor_samples ?? cue.recordingAnchorSamples, 0)
    : null;
  const recordingMinusDemo = recordingAnchor - demoAnchor;
  const clips = [];
  const gaps = [];
  const fadeDiagnostics = [];
  const transitions = [];
  const warnings = [];
  const mappingDiagnostics = [];
  const assumptions = [
    "Edited demo source ranges identify the approved music edit.",
    "Recording reference source ranges locate those same moments on the recording timeline.",
    "Source ranges should be enriched from GetClipList when available."
  ];

  const recordingReferenceTrack = referenceTrackName(cue);
  let referenceSegments = [];
  if (usesReferenceMapping) {
    if (!findTrack(recordingSession, recordingReferenceTrack)) {
      warnings.push(`Cue ${cueId}: recording reference track not found: ${recordingReferenceTrack}`);
    } else {
      referenceSegments = referenceTimelineForTrack(recordingSession, recordingReferenceTrack, {
        includeMuted: Boolean(cue.include_muted_reference ?? true),
        includeHidden: cue.include_hidden ?? true,
        includeInactive: cue.include_inactive ?? true,
        channel: cue.recording_reference_channel ?? cue.recordingReferenceChannel ?? 1
      });
      if (!referenceSegments.length) {
        warnings.push(`Cue ${cueId}: recording reference track has no usable audio clips: ${recordingReferenceTrack}`);
      }
    }
  } else if (!usesLegacyAnchors) {
    warnings.push(`Cue ${cueId}: missing recording_reference_track.`);
  }

  for (const targetTrack of asArray(cue.target_tracks ?? cue.targetTracks)) {
    const target = targetTrackConfig(cue, targetTrack);
    target.cueId = cueId;
    const targetWarning = message => {
      warnings.push(message);
      if(partialPolicy) mappingDiagnostics.push({severity:"warning",code:"missing-track-mapping",message,
        destinationTrack:target.destinationTrack,sourceTrack:target.sourceTrack});
    };

    if (!target.sourceTrack) {
      targetWarning(`Cue ${cueId}: target track is missing source_track.`);
      continue;
    }
    if (!target.demoTracks.length) {
      targetWarning(`Cue ${cueId}: target ${target.sourceTrack} is missing demo_track.`);
      continue;
    }
    if (!findTrack(recordingSession, target.sourceTrack)) {
      targetWarning(`Cue ${cueId}: recording track not found: ${target.sourceTrack}`);
      continue;
    }

    const demoCrossfades = [];
    const demoStandaloneFades = [];
    const demoSegments = target.demoTracks.flatMap((demoTrack) => {
      if (!findTrack(demoSession, demoTrack)) {
        targetWarning(`Cue ${cueId}: demo track not found: ${demoTrack}`);
        return [];
      }
      const editTimeline = editTimelineForTrack(demoSession, demoTrack, {
        includeMuted: target.includeMutedDemo,
        includeHidden: target.includeHidden,
        includeInactive: target.includeInactive,
        channel: target.demoChannel
      });
      demoCrossfades.push(...editTimeline.crossfades);
      demoStandaloneFades.push(...editTimeline.standaloneFades);
      return editTimeline.segments;
    });

    const recordingEvents = trackEventsForConform(recordingSession, target.sourceTrack, {
      includeMuted: target.includeMutedRecording,
      includeHidden: target.includeHidden,
      includeInactive: target.includeInactive,
      includeFades: true
    });
    const recordingSegments = recordingTimelineForTrack(recordingSession, target.sourceTrack, {
      includeMuted: target.includeMutedRecording,
      includeHidden: target.includeHidden,
      includeInactive: target.includeInactive
    }).filter((event) => event.type === "audio");
    const recordingEventsByChannel = eventsByChannel(recordingEvents);

    const targetClipStartIndex = clips.length;
    const targetGapStartIndex = gaps.length;
    for (const demoSegment of demoSegments) {
      const localIssue = (code, message, segment = demoSegment) => mappingDiagnostics.push({severity:"warning",code,message,
        destinationTrack:target.destinationTrack,sourceTrack:target.sourceTrack,
        demoClipName:demoSegment.clipName,timelineStartSamples:segment.timelineStartSamples,timelineEndSamples:segment.timelineEndSamples});
      if(partialPolicy && (demoSession.metadata.sampleRate!==recordingSession.metadata.sampleRate)) {
        localIssue("unverified-mapping","Recording and Edit sample rates differ; source positions are not verified. Skip this clip.");continue;
      }
      if(partialPolicy && demoSegment.mappingUnverified) {
        localIssue("unverified-mapping","Clip or Recording Reference metadata is missing or ambiguous. The proposed audio positions require manual review.");
      }
      if (demoSegment.sourceStartSamples === null || demoSegment.sourceEndSamples === null) {
        localIssue("position-reference-partial", `Cue ${cueId}: demo clip lacks source range: ${demoSegment.clipName}`);
        continue;
      }

      let mappedRanges = usesReferenceMapping
        ? mapEditSegmentThroughReference(demoSegment, referenceSegments)
        : usesLegacyAnchors
          ? [{
            sourceStartSamples: demoSegment.sourceStartSamples,
            sourceEndSamples: demoSegment.sourceEndSamples,
            recordingStartSamples: demoSegment.sourceStartSamples + recordingMinusDemo,
            recordingEndSamples: demoSegment.sourceEndSamples + recordingMinusDemo,
            editTimelineStartSamples: demoSegment.timelineStartSamples,
            editTimelineEndSamples: demoSegment.timelineEndSamples,
            referenceClipName: "",
            identityMatched: false
          }]
          : [];

      if(partialPolicy && mappedRanges.some((a,i)=>mappedRanges.slice(i+1).some(b=>a.sourceStartSamples<b.sourceEndSamples&&b.sourceStartSamples<a.sourceEndSamples))) {
        localIssue("unverified-mapping","This clip maps to multiple Recording Reference occurrences. The draft uses the first occurrence; review its position before or after import.");
        // Keep a deterministic draft for explicit Import Anyway approval, never
        // place several overlapping copies of the same Edit occurrence.
        mappedRanges = mappedRanges.filter((range,index,all)=>!all.slice(0,index).some(previous=>
          previous.sourceStartSamples<range.sourceEndSamples&&range.sourceStartSamples<previous.sourceEndSamples));
      }
      if (!mappedRanges.length) {
        const message = `Cue ${cueId}: edit demo source range is not covered by recording reference: ${demoSegment.clipName}`;
        warnings.push(message);
        mappingDiagnostics.push({
          severity: "warning", code: "position-reference-partial", message,
          coverage: "uncovered", destinationTrack: target.destinationTrack,
          sourceTrack: target.sourceTrack, demoClipName: demoSegment.clipName,
          timelineStartSamples: demoSegment.timelineStartSamples,
          timelineEndSamples: demoSegment.timelineEndSamples
        });
        continue;
      }

      const mappedSamples = mappedRanges.reduce(
        (sum, range) => sum + (range.sourceEndSamples - range.sourceStartSamples),
        0
      );
      if (mappedSamples < demoSegment.sourceEndSamples - demoSegment.sourceStartSamples) {
        const message = `Cue ${cueId}: recording reference only partially covers edit demo clip: ${demoSegment.clipName}`;
        warnings.push(message);
        // Describe only the absent source intervals. Never drop the usable
        // remainder (or a distant fade) because this occurrence is trimmed.
        let cursor = demoSegment.sourceStartSamples;
        const missing = [];
        for (const range of mappedRanges) {
          if (range.sourceStartSamples > cursor) missing.push([cursor,range.sourceStartSamples]);
          cursor = Math.max(cursor,range.sourceEndSamples);
        }
        if (cursor < demoSegment.sourceEndSamples) missing.push([cursor,demoSegment.sourceEndSamples]);
        for (const [start,end] of missing) mappingDiagnostics.push({
          severity:"warning",code:"position-reference-partial",message,
          coverage:"partial",uncoveredOnly:true,destinationTrack:target.destinationTrack,
          sourceTrack:target.sourceTrack,demoClipName:demoSegment.clipName,
          timelineStartSamples:demoSegment.timelineStartSamples+start-demoSegment.sourceStartSamples,
          timelineEndSamples:demoSegment.timelineStartSamples+end-demoSegment.sourceStartSamples,
          durationSamples:end-start,durationSeconds:(end-start)/demoSession.metadata.sampleRate
        });
      }

      for (const mappedRange of mappedRanges) {
        if (partialPolicy && mappedRange.mappingUnverified && !demoSegment.mappingUnverified) {
          localIssue("unverified-mapping", "Clip or Recording Reference metadata is missing or ambiguous. The proposed audio positions require manual review.", {
            timelineStartSamples:mappedRange.editTimelineStartSamples, timelineEndSamples:mappedRange.editTimelineEndSamples
          });
        }
        if (mappedRange.extendedReference) mappingDiagnostics.push({severity:'info',code:'extended-reference-mapping',
          destinationTrack:target.destinationTrack,sourceTrack:target.sourceTrack,demoClipName:demoSegment.clipName,
          timelineStartSamples:mappedRange.editTimelineStartSamples,timelineEndSamples:mappedRange.editTimelineEndSamples,
          message:'Used the unique reference sample offset beyond its trimmed playlist boundary. Only available recorded audio is included; existing audio positions are unchanged.'});
        const r0 = mappedRange.recordingStartSamples;
        const r1 = mappedRange.recordingEndSamples;
        const mappedDemoSegment = {
          ...demoSegment,
          mappingUnverified: Boolean(demoSegment.mappingUnverified || mappedRange.mappingUnverified),
          timelineStartSamples: mappedRange.editTimelineStartSamples,
          timelineEndSamples: mappedRange.editTimelineEndSamples,
          sourceStartSamples: mappedRange.sourceStartSamples,
          sourceEndSamples: mappedRange.sourceEndSamples,
          fadeMappingStartSamples: mappedRange.fadeMappingStartSamples,
          fadeMappingEndSamples: mappedRange.fadeMappingEndSamples,
          recordingReferenceTrack,
          recordingReferenceClipName: mappedRange.referenceClipName,
          referenceMatchBasis: mappedRange.referenceMatchBasis
        };
        const overlaps = [];
        const transitionOverlaps = [];

        for (const recordingSegment of recordingSegments) {
          const overlapStart = Math.max(r0, recordingSegment.timelineStartSamples);
          const overlapEnd = Math.min(r1, recordingSegment.timelineEndSamples);
          if (overlapStart >= overlapEnd) continue;
          if (recordingSegment.sourceStartSamples === null || recordingSegment.sourceEndSamples === null) {
            mappingDiagnostics.push({severity:"warning",code:"unverified-recording-range",uncoveredOnly:true,
              message:`Cue ${cueId}: recording clip lacks source range: ${recordingSegment.clipName}`,
              destinationTrack:target.destinationTrack,sourceTrack:target.sourceTrack,
              timelineStartSamples:mappedDemoSegment.timelineStartSamples+overlapStart-r0,
              timelineEndSamples:mappedDemoSegment.timelineStartSamples+overlapEnd-r0});
            continue;
          }
          if (overlapStart < overlapEnd) {
            if(partialPolicy && recordingSegment.mappingUnverified) {
              localIssue("unverified-recording-range","Recorded clip metadata is missing or ambiguous. The proposed source range requires manual review.",{
                timelineStartSamples:mappedDemoSegment.timelineStartSamples+overlapStart-r0,
                timelineEndSamples:mappedDemoSegment.timelineStartSamples+overlapEnd-r0});
            }
            overlaps.push({ recordingSegment, overlapStart, overlapEnd });
            clips.push(buildClip(target, mappedDemoSegment, recordingSegment, overlapStart, overlapEnd, r0));
          }
        }

        for (const channelEvents of recordingEventsByChannel.values()) {
          for (const transition of buildCrossfadeTransitions(target, mappedDemoSegment, channelEvents, r0, r1)) {
            transitionOverlaps.push({
              overlapStart: transition.overlapStartSamples,
              overlapEnd: transition.overlapEndSamples
            });
            transitions.push(transition);
          }
        }

        const coverage = [...overlaps, ...transitionOverlaps]
          .sort((a, b) => a.overlapStart - b.overlapStart || a.overlapEnd - b.overlapEnd);
        let cursor = r0;
        for (const overlap of coverage) {
          if (overlap.overlapStart > cursor) {
            pushGap(gaps, target, mappedDemoSegment, cursor, overlap.overlapStart, r0);
          }
          cursor = Math.max(cursor, overlap.overlapEnd);
        }
        if (cursor < r1) {
          pushGap(gaps, target, mappedDemoSegment, cursor, r1, r0);
        }
      }
    }

    const targetClips = repairFadeCoverage(clips.slice(targetClipStartIndex), demoStandaloneFades, demoCrossfades, fadeDiagnostics, recordingSegments);
    clips.splice(targetClipStartIndex, clips.length - targetClipStartIndex, ...targetClips);
    const expectedChannels = [...new Set(recordingSegments.map(c => c.channel))];
    gaps.splice(targetGapStartIndex, gaps.length - targetGapStartIndex, ...remainingFadeGaps(gaps.slice(targetGapStartIndex), targetClips, expectedChannels));
    if (!expectedChannels.length && (demoCrossfades.length || demoStandaloneFades.length)) {
      mappingDiagnostics.push({severity:"warning",code:"missing-track-mapping",destinationTrack:target.destinationTrack,
        sourceTrack:target.sourceTrack,message:`${target.destinationTrack}: no recorded audio is available to reconstruct the Edit fades.`});
    }
    transitions.push(...buildEditCrossfadeTransitions(target, demoCrossfades, targetClips, fadeDiagnostics, expectedChannels, recordingSegments));
    transitions.push(...buildEditStandaloneFadeTransitions(target, demoStandaloneFades, targetClips, fadeDiagnostics, expectedChannels));
    // Check the actual EDL fade intervals, including those normalization could
    // not attach to an audio event. Otherwise a lost fade can appear as success.
    for (const demoTrack of target.demoTracks) {
      const events = trackEventsForConform(demoSession,demoTrack,{includeFades:true,includeMuted:target.includeMutedDemo,channel:target.demoChannel});
      for (const fade of events.filter(e=>e.isFade)) {
        const uncovered = [];
        for (const channel of expectedChannels) {
          let cursor=fade.timelineStartSamples;
          for (const clip of targetClips.filter(c=>c.demoTrack===demoTrack && c.channel===channel
            && c.timelineStartSamples<fade.timelineEndSamples && c.timelineEndSamples>fade.timelineStartSamples)
            .sort((a,b)=>a.timelineStartSamples-b.timelineStartSamples)) {
            if(clip.timelineStartSamples>cursor) uncovered.push([cursor,clip.timelineStartSamples]);
            cursor=Math.max(cursor,Math.min(fade.timelineEndSamples,clip.timelineEndSamples));
          }
          if(cursor<fade.timelineEndSamples) uncovered.push([cursor,fade.timelineEndSamples]);
        }
        const unique=[...new Map(uncovered.map(r=>[r.join(':'),r])).values()];
        for(const [start,end] of unique) mappingDiagnostics.push({severity:'warning',code:'reference-fade-coverage',
          destinationTrack:target.destinationTrack,sourceTrack:target.sourceTrack,type:fade.type,
          timelineStartSamples:start,timelineEndSamples:end,durationSamples:end-start,
          durationSeconds:(end-start)/demoSession.metadata.sampleRate,
          message:`Reference fade audio is not fully covered at samples ${start}–${end} (${((end-start)/demoSession.metadata.sampleRate).toFixed(6)} seconds). Review the missing audio after import.`});
      }
    }
  }

  const uniqueWarnings = [...new Set(warnings)];
  return {
    cueId,
    requestedTargetTracks: asArray(cue.target_tracks ?? cue.targetTracks).length,
    destinationTracks: asArray(cue.target_tracks ?? cue.targetTracks).map(t=>targetTrackConfig(cue,t).destinationTrack),
    mappingMode: usesReferenceMapping
      ? "demo_source_via_recording_reference"
      : usesLegacyAnchors
        ? "legacy_anchors"
        : "missing",
    recordingReferenceTrack,
    demoAnchorSamples: demoAnchor,
    recordingAnchorSamples: recordingAnchor,
    clips,
    gaps,
    fadeDiagnostics,
    transitions,
    warnings: uniqueWarnings,
    mappingDiagnostics,
    assumptions
  };
}

export function conformManifest({ manifest, demoSession, recordingSession, partialPolicy = false }) {
  const cues = asArray(manifest.cues).map((cue) => conformCue({ cue, demoSession, recordingSession, partialPolicy }));
  const clips = cues.flatMap((cue) => cue.clips);
  const gaps = cues.flatMap((cue) => cue.gaps);
  const transitions = cues.flatMap((cue) => cue.transitions ?? []);
  const warnings = cues.flatMap((cue) => cue.warnings);
  return {
    project: manifest.project ?? "",
    sampleRate: manifest.sample_rate ?? manifest.sampleRate ?? demoSession.metadata.sampleRate,
    cues,
    clips,
    fadeDiagnostics: cues.flatMap(cue => cue.fadeDiagnostics ?? []),
    mappingDiagnostics: cues.flatMap(cue => cue.mappingDiagnostics ?? []),
    gaps,
    transitions,
    warnings,
    summary: summarizeConform({ cues, clips, gaps, transitions, warnings })
  };
}

export function summarizeConform({ cues, clips, gaps, transitions = [], warnings }) {
  const byDestinationTrack = {};
  for (const clip of clips) {
    byDestinationTrack[clip.destinationTrack] ??= { clips: 0, durationSamples: 0 };
    byDestinationTrack[clip.destinationTrack].clips += 1;
    byDestinationTrack[clip.destinationTrack].durationSamples += clip.durationSamples;
  }
  return {
    cues: cues.length,
    requestedTargetTracks: cues.reduce(
      (sum, cue) => sum + (cue.requestedTargetTracks ?? 0),
      0
    ),
    outputClipEntries: clips.length,
    gaps: gaps.length,
    gapSamples: gaps.reduce((sum, gap) => sum + gap.durationSamples, 0),
    transitions: transitions.length,
    transitionSamples: transitions.reduce((sum, transition) => sum + transition.durationSamples, 0),
    diagnostics: {
      offlineSourceClips: clips.filter((clip) => clip.sourceClipOnline === false).length,
      offlineSourceFiles: clips.filter((clip) => clip.sourceFileOnline === false).length,
      missingSourceFilePaths: clips.filter((clip) => !clip.sourceFilePath).length,
      clipsFromInactiveSourceTracks: clips.filter((clip) => clip.sourceTrackInactive).length,
      clipsFromInactiveDemoTracks: clips.filter((clip) => clip.demoTrackInactive).length
    },
    warnings: warnings.length,
    byDestinationTrack
  };
}
