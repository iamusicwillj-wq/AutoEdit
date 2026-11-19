// Limits for reading extra samples on either side of this recording occurrence.
// A neighboring take with a different source offset is a real boundary even
// when the underlying file contains more samples.
export function recordingHandleLimits(clip, recordingSegments = []) {
  let start = clip.timelineStartSamples-clip.sourceStartSamples;
  let end = Number.isFinite(clip.sourceFileKnownEndSamples)
    ? clip.timelineEndSamples+clip.sourceFileKnownEndSamples-clip.sourceEndSamples : Infinity;
  const offset = clip.sourceStartSamples-clip.recordingStartSamples;
  for (const segment of recordingSegments) {
    if (segment.channel !== clip.channel) continue;
    if (!segment.mappingUnverified && segment.sourceFilePath === clip.sourceFilePath
      && segment.sourceStartSamples-segment.timelineStartSamples === offset) continue;
    if (segment.timelineEndSamples <= clip.recordingStartSamples) {
      start = Math.max(start,clip.timelineStartSamples+segment.timelineEndSamples-clip.recordingStartSamples);
    } else if (segment.timelineStartSamples >= clip.recordingEndSamples) {
      end = Math.min(end,clip.timelineEndSamples+segment.timelineStartSamples-clip.recordingEndSamples);
    } else {
      start = Math.max(start,clip.timelineStartSamples);
      end = Math.min(end,clip.timelineEndSamples);
    }
  }
  return {start,end};
}

// Recover only fade-local handles; never stretch, move, or render recorded audio.
export function repairFadeCoverage(clips, standaloneFades, crossfades, diagnostics, recordingSegments = []) {
  const channels = [...new Set(clips.map(c => c.channel))];
  const note = (severity, type, event, channel, message) => diagnostics.push({
    severity, code: 'fade-coverage', type, channel,
    destinationTrack: clips[0]?.destinationTrack ?? '',
    timelineStartSamples: event.timelineStartSamples,
    timelineEndSamples: event.timelineEndSamples,
    message
  });
  const belongs = (clip, audio) => clip.demoEventId === audio.demoEventId;
  function extend(clip, edge, position, fade) {
    if (!clip) return false;
    const old = edge === 'start' ? clip.timelineStartSamples : clip.timelineEndSamples;
    if (old === position) return true;
    if (old < fade.timelineStartSamples || old > fade.timelineEndSamples) return false;
    const outsidePlaylist = position < clip.mappingTimelineStartSamples || position > clip.mappingTimelineEndSamples;
    if (outsidePlaylist) {
      if (clip.mappingUnverified
        || !Number.isFinite(clip.fadeMappingStartSamples) || !Number.isFinite(clip.fadeMappingEndSamples)
        || position < clip.fadeMappingStartSamples || position > clip.fadeMappingEndSamples) return false;
    }
    const limits = recordingHandleLimits(clip, recordingSegments);
    if (position < limits.start || position > limits.end) return false;
    const delta = position - old;
    const source = (edge === 'start' ? clip.sourceStartSamples : clip.sourceEndSamples) + delta;
    if (source < 0 || !Number.isFinite(clip.sourceFileKnownEndSamples) || source > clip.sourceFileKnownEndSamples) return false;
    if (edge === 'start') {
      clip.timelineStartSamples = position;
      clip.sourceStartSamples = source;
      clip.recordingStartSamples += delta;
    } else {
      clip.timelineEndSamples = position;
      clip.sourceEndSamples = source;
      clip.recordingEndSamples += delta;
    }
    clip.durationSamples = clip.timelineEndSamples - clip.timelineStartSamples;
    if (outsidePlaylist) {
      diagnostics.push({severity:'info',code:'recovered-fade-boundary',type:fade.type,channel:clip.channel,
        destinationTrack:clip.destinationTrack,timelineStartSamples:fade.timelineStartSamples,timelineEndSamples:fade.timelineEndSamples,
        message:'Recovered fade coverage using the selected reference mapping and source-file handles. Existing audio positions were preserved; review this fade after import.'});
    }
    return true;
  }
  function pieces(audio, channel) {
    return clips.filter(c => c.channel === channel && belongs(c, audio))
      .sort((a,b) => a.timelineStartSamples - b.timelineStartSamples);
  }
  function mergeContinuous(audio, channel, fade) {
    const ordered = pieces(audio, channel);
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i-1], b = ordered[i];
      const join = a.timelineEndSamples;
      if (join < fade.timelineStartSamples || join > fade.timelineEndSamples) continue;
      if (join !== b.timelineStartSamples || a.sourceEndSamples !== b.sourceStartSamples
          || !a.sourceFilePath || a.sourceFilePath !== b.sourceFilePath
          || a.sourceChannel !== b.sourceChannel || a.isMuted !== b.isMuted
          || a.recordingEndSamples !== b.recordingStartSamples
          || a.hiddenSourceSuffixSamples || b.hiddenSourcePrefixSamples) continue;
      a.timelineEndSamples = b.timelineEndSamples;
      a.sourceEndSamples = b.sourceEndSamples;
      a.recordingEndSamples = b.recordingEndSamples;
      a.mappingTimelineEndSamples = b.mappingTimelineEndSamples;
      a.hiddenSourceSuffixSamples = b.hiddenSourceSuffixSamples;
      a.durationSamples = a.timelineEndSamples - a.timelineStartSamples;
      a.sourceFileKnownEndSamples = Math.max(a.sourceFileKnownEndSamples ?? 0, b.sourceFileKnownEndSamples ?? 0) || null;
      clips.splice(clips.indexOf(b), 1);
      ordered[i] = a;
      note('info', fade.type, fade, channel, 'Joined contiguous fragments from the same source for the fade.');
    }
  }
  for (const {audio,event,type} of standaloneFades) {
    for (const channel of channels) {
      mergeContinuous(audio, channel, event);
      const candidates = pieces(audio, channel);
      const clip = type === 'fade-in' ? candidates[0] : candidates.at(-1);
      if (!clip) continue;
      const edge = type === 'fade-in' ? 'start' : 'end';
      const limits = recordingHandleLimits(clip,recordingSegments);
      const expected = type === 'fade-in'
        ? Math.max(event.timelineStartSamples,limits.start,clip.fadeMappingStartSamples ?? clip.mappingTimelineStartSamples)
        : Math.min(event.timelineEndSamples,limits.end,clip.fadeMappingEndSamples ?? clip.mappingTimelineEndSamples);
      const old = type === 'fade-in' ? clip.timelineStartSamples : clip.timelineEndSamples;
      if (old !== expected && extend(clip, edge, expected, event)) {
        note('info', type, event, channel, 'Recovered trimmed fade samples from verified source-file handles.');
      }
    }
  }
  for (const descriptor of crossfades) {
    const {left,right,event,editBoundarySamples} = descriptor;
    const pairs = [];
    for (const channel of channels) {
      mergeContinuous(left, channel, event);
      mergeContinuous(right, channel, event);
      const a = pieces(left, channel).at(-1), b = pieces(right, channel)[0];
      pairs.push({channel,a,b});
    }
    // An original cut may be just before the right source file begins. Move
    // only the trim boundary within the fade, identically on every channel;
    // neither source-to-timeline offset changes.
    let minimum = event.timelineStartSamples, maximum = event.timelineEndSamples;
    for (const {a,b} of pairs) {
      if (!a || !b) continue;
      minimum = Math.max(minimum,recordingHandleLimits(b,recordingSegments).start,
        b.fadeMappingStartSamples ?? b.mappingTimelineStartSamples);
      maximum = Math.min(maximum,recordingHandleLimits(a,recordingSegments).end,
        a.fadeMappingEndSamples ?? a.mappingTimelineEndSamples);
    }
    const boundary = minimum <= maximum
      ? Math.min(maximum,Math.max(minimum,editBoundarySamples)) : editBoundarySamples;
    descriptor.appliedEditBoundarySamples = boundary;
    for (const {channel,a,b} of pairs) {
      for (const [clip,edge] of [[a,'end'],[b,'start']]) {
        if (!clip) continue;
        const old = edge === 'end' ? clip.timelineEndSamples : clip.timelineStartSamples;
        if (old !== boundary && extend(clip, edge, boundary, event)) {
          note('info', 'crossfade', event, channel, 'Recovered trimmed clip edge at the edit boundary from verified source-file handles.');
        }
      }
    }
  }
  return clips;
}

// Remove only gaps now covered on every microphone channel. Keep genuine gaps.
export function remainingFadeGaps(gaps, clips, channels) {
  if (!channels.length) return gaps;
  return gaps.flatMap(gap => {
    // Either arm of a repaired crossfade can cover the interval. A missing
    // handle on the other arm is reported separately as a shortened fade.
    const matching = clips.filter(c => c.destinationTrack === gap.destinationTrack && c.demoTrack === gap.demoTrack);
    const bounds = [...new Set([gap.timelineStartSamples, gap.timelineEndSamples,
      ...matching.flatMap(c => [c.timelineStartSamples, c.timelineEndSamples])
        .filter(n => n > gap.timelineStartSamples && n < gap.timelineEndSamples)])].sort((a,b) => a-b);
    const remaining = [];
    for (let i = 0; i < bounds.length-1; i++) {
      const start = bounds[i], end = bounds[i+1];
      if (channels.every(channel => matching.some(c => c.channel === channel && c.timelineStartSamples <= start && c.timelineEndSamples >= end))) continue;
      remaining.push({...gap, timelineStartSamples:start, timelineEndSamples:end,
        recordingStartSamples:gap.recordingStartSamples + start-gap.timelineStartSamples,
        recordingEndSamples:gap.recordingStartSamples + end-gap.timelineStartSamples, durationSamples:end-start});
    }
    return remaining;
  });
}
