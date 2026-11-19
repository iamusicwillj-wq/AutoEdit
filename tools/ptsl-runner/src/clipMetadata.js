function positionToSamples(position) {
  if (!position) {
    return null;
  }
  const value = position.position ?? position.location ?? position.length;
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function filenameFromAnyPath(value) {
  return String(value ?? "")
    .split(/[/:\\]/)
    .filter(Boolean)
    .at(-1) ?? "";
}

function buildFileLocationById(fileLocations = []) {
  const byId = new Map();
  for (const location of fileLocations) {
    if (location.file_id) {
      byId.set(location.file_id, location);
    }
  }
  return byId;
}

function clipFullName(clip) {
  return clip.clip_full_name ?? clip.clipFullName ?? "";
}

function clipFileId(clip) {
  return clip.file_id ?? clip.fileId ?? "";
}

function clipSourceStart(clip) {
  return positionToSamples(clip.src_start_point ?? clip.srcStartPoint);
}

function clipSourceEnd(clip) {
  return positionToSamples(clip.src_end_point ?? clip.srcEndPoint);
}

function clipIsOnline(clip) {
  const value = clip.is_online ?? clip.isOnline;
  return typeof value === "boolean" ? value : null;
}

function fileIsOnline(fileLocation) {
  const value = fileLocation?.info?.is_online ?? fileLocation?.info?.isOnline;
  return typeof value === "boolean" ? value : null;
}

function clipMetadataKey(clip) {
  return [
    clipFileId(clip),
    clipSourceStart(clip),
    clipSourceEnd(clip),
    clipIsOnline(clip)
  ].join("|");
}

function equivalentClipMetadata(candidates) {
  if (candidates.length <= 1) {
    return true;
  }
  return new Set(candidates.map(clipMetadataKey)).size === 1;
}

// A playlist timestamp is only a hint: require the same file identity and
// agreement with both source start and the clip's user timestamp. The caller
// must still prove that the occurrence fits, or solve its fade chain.
function occurrenceOriginCandidates(event, candidates) {
  const origins = new Set(candidates.map(c => [clipFileId(c), clipSourceStart(c), clipIsOnline(c)].join('|')));
  if (origins.size <= 1) return candidates;
  if (event.sourceRangeBasis !== 'track_edl_timestamp' || !Number.isSafeInteger(event.timestampSamples)
    || !candidates.length || !clipFileId(candidates[0])
    || new Set(candidates.map(c => [clipFileId(c), clipIsOnline(c)].join('|'))).size !== 1) return candidates;
  const matched = candidates.filter(c => clipSourceStart(c) === event.timestampSamples
    && positionToSamples(c.user_timestamp_point ?? c.userTimestampPoint) === event.timestampSamples);
  return matched.length ? matched : candidates;
}

function cloneSession(session) {
  return JSON.parse(JSON.stringify(session));
}

function candidatesForEvent(event, clipList, fileLocationById) {
  const sameName = clipList.filter((clip) => clipFullName(clip) === event.clipName);
  if (sameName.length <= 1 || !event.sourceFile) {
    return sameName;
  }

  const sameFile = sameName.filter((clip) => {
    const fileLocation = fileLocationById.get(clipFileId(clip));
    return filenameFromAnyPath(fileLocation?.path) === event.sourceFile;
  });
  return sameFile.length ? sameFile : sameName;
}

// The EDL describes playlist occurrences; the clip list can contain several
// revisions with the same name. Resolve each occurrence independently.
// Crossfades share handles between two events and need separate reconstruction.
function resolveOccurrence(event, events, candidates) {
  const channel = events.filter(e => e.channel === event.channel)
    .sort((a,b) => a.timelineStartSamples-b.timelineStartSamples || a.event-b.event);
  const index = channel.indexOf(event), before = channel[index-1], after = channel[index+1];
  if (before?.type === 'crossfade' || after?.type === 'crossfade') return candidates;
  const originalCandidates = candidates;
  candidates = occurrenceOriginCandidates(event, candidates);
  const prefix = before?.type === 'fade-in' && before.timelineEndSamples === event.timelineStartSamples
    ? before.timelineEndSamples-before.timelineStartSamples : 0;
  const suffix = after?.type === 'fade-out' && after.timelineStartSamples === event.timelineEndSamples
    ? after.timelineEndSamples-after.timelineStartSamples : 0;
  const length = event.timelineEndSamples-event.timelineStartSamples+prefix+suffix;
  const exact = candidates.filter(c => clipSourceStart(c) !== null && clipSourceEnd(c) !== null
    && clipSourceStart(c) >= 0 && clipSourceEnd(c)-clipSourceStart(c) === length);
  // Length alone must not choose between distinct source identities/positions.
  const sameOrigin = new Set(candidates.map(c=>[clipFileId(c),clipSourceStart(c),clipIsOnline(c)].join('|'))).size === 1;
  if (sameOrigin && exact.length && equivalentClipMetadata(exact)) {
    event.clipMetadataResolution = {basis:'occurrence-duration-with-fades',
      candidateIds:originalCandidates.map(c=>c.clip_id ?? c.clipId), expectedDurationSamples:length};
    return exact;
  }
  // A plain playlist occurrence may use only part of a longer source clip.
  // Once timestamp evidence distinguishes its origin, an unused tail is not
  // ambiguity. Do not extend the EDL interval or borrow the next clip's fade.
  if (!prefix && !suffix && candidates.length < originalCandidates.length
      && sameOrigin && equivalentClipMetadata(candidates) && candidates.length
      && Number.isSafeInteger(clipSourceStart(candidates[0])) && clipSourceStart(candidates[0]) >= 0
      && clipSourceEnd(candidates[0])-clipSourceStart(candidates[0]) >= length) {
    event.clipMetadataResolution = {basis:'occurrence-origin-with-trimmed-tail',
      candidateIds:originalCandidates.map(c=>c.clip_id ?? c.clipId), expectedDurationSamples:length};
    return candidates;
  }
  return originalCandidates;
}

// Adjacent clips divide a crossfade's hidden samples between them. Solve the
// complete chain instead of picking a same-name revision by list order. Only
// source-identical candidates may be resolved this way; a matching duration
// must never select a different file or source origin.
function resolveCrossfadeOccurrences(events, candidatesByEvent) {
  const channels = new Map();
  for (const event of events) {
    if (!channels.has(event.channel)) channels.set(event.channel, []);
    channels.get(event.channel).push(event);
  }
  for (const channel of channels.values()) {
    channel.sort((a,b) => a.timelineStartSamples-b.timelineStartSamples || a.event-b.event);
    const joined = index => channel[index]?.type === 'audio'
      && channel[index+1]?.type === 'crossfade' && channel[index+2]?.type === 'audio'
      && channel[index].timelineEndSamples === channel[index+1].timelineStartSamples
      && channel[index+1].timelineEndSamples === channel[index+2].timelineStartSamples;
    for (let start = 0; start < channel.length; start++) {
      if (!joined(start)) continue;
      let end = start;
      while (joined(end)) end += 2;
      const nodes = [];
      for (let i = start; i <= end; i += 2) nodes.push(channel[i]);
      const originalSets = nodes.map(event => candidatesByEvent.get(event) ?? []);
      const sets = nodes.map((event,n) => occurrenceOriginCandidates(event, originalSets[n]));
      const sameOrigin = candidates => candidates.length > 0 && clipFileId(candidates[0])
        && new Set(candidates.map(c => [clipFileId(c),clipSourceStart(c),clipIsOnline(c)].join('|'))).size === 1;
      if (sets.some(c => !sameOrigin(c)) || originalSets.every(equivalentClipMetadata)) {
        start = end;
        continue;
      }
      const leadingFade = channel[start-1];
      const trailingFade = channel[end+1];
      const leading = leadingFade?.type === 'fade-in'
        && leadingFade.timelineEndSamples === nodes[0].timelineStartSamples
        ? leadingFade.timelineEndSamples-leadingFade.timelineStartSamples : 0;
      const trailing = trailingFade?.type === 'fade-out'
        && trailingFade.timelineStartSamples === nodes.at(-1).timelineEndSamples
        ? trailingFade.timelineEndSamples-trailingFade.timelineStartSamples : 0;
      const layers = [];
      for (let n = 0; n < nodes.length; n++) {
        const event = nodes[n], states = new Map();
        const before = n ? channel[start+2*n-1] : null;
        const after = n+1 < nodes.length ? channel[start+2*n+1] : null;
        for (const clip of sets[n]) {
          const sourceStart = clipSourceStart(clip), sourceEnd = clipSourceEnd(clip);
          if (!Number.isSafeInteger(sourceStart) || !Number.isSafeInteger(sourceEnd) || sourceStart < 0) continue;
          const hidden = sourceEnd-sourceStart-(event.timelineEndSamples-event.timelineStartSamples);
          for (const previous of n ? layers[n-1] : [null]) {
            const prefix = before ? before.timelineEndSamples-before.timelineStartSamples-previous.suffix : leading;
            const suffix = hidden-prefix;
            if (!Number.isSafeInteger(prefix) || !Number.isSafeInteger(suffix) || prefix < 0 || suffix < 0
              || (after ? suffix > after.timelineEndSamples-after.timelineStartSamples : suffix !== trailing)) continue;
            const key = `${clipMetadataKey(clip)}|${prefix}|${suffix}`;
            if (!states.has(key)) states.set(key, {clip,prefix,suffix,previous:new Set()});
            if (previous) states.get(key).previous.add(previous);
          }
        }
        layers.push([...states.values()]);
      }
      // Keep only states participating in a complete solution. Multiple paths
      // can share a state; do not enumerate exponentially many combinations.
      const viable = layers.map(() => new Set());
      viable[viable.length-1] = new Set(layers.at(-1));
      for (let n = viable.length-1; n > 0; n--) {
        for (const state of viable[n]) for (const previous of state.previous) viable[n-1].add(previous);
      }
      if (viable.every(states => states.size === 1)) {
        nodes.forEach((event,n) => {
          const [{clip,prefix,suffix}] = viable[n];
          event.clipMetadataResolution = {
            basis:'occurrence-duration-with-crossfades',
            candidateIds:originalSets[n].map(c => c.clip_id ?? c.clipId),
            expectedDurationSamples:clipSourceEnd(clip)-clipSourceStart(clip),
            hiddenPrefixSamples:prefix, hiddenSuffixSamples:suffix
          };
          candidatesByEvent.set(event, [clip]);
        });
      }
      start = end;
    }
  }
}

export function enrichSessionWithClipMetadata(session, metadata) {
  const enriched = cloneSession(session);
  const clipList = metadata.clips ?? [];
  const fileLocations = metadata.file_locations ?? metadata.fileLocations ?? [];
  const fileLocationById = buildFileLocationById(fileLocations);

  // A known clip range proves that these source samples exist, even when a
  // shorter playlist instance has trimmed them away. This is a lower bound.
  const knownFileEnds = new Map();
  for (const clip of clipList) {
    const end = clipSourceEnd(clip);
    if (clipFileId(clip) && end !== null && clipIsOnline(clip) !== false) {
      knownFileEnds.set(clipFileId(clip), Math.max(knownFileEnds.get(clipFileId(clip)) ?? 0, end));
    }
  }

  for (const track of enriched.tracks) {
    const candidatesByEvent = new Map(track.events.filter(event => !event.isFade)
      .map(event => [event,candidatesForEvent(event,clipList,fileLocationById)]));
    resolveCrossfadeOccurrences(track.events,candidatesByEvent);
    for (const event of track.events) {
      if (event.isFade) {
        continue;
      }
      let candidates = candidatesByEvent.get(event);
      if (candidates.length > 1 && !equivalentClipMetadata(candidates)) {
        candidates = resolveOccurrence(event, track.events, candidates);
      }
      if (candidates.length === 0) {
        enriched.warnings.push(`GetClipList metadata did not contain clip: ${event.clipName}`);
        event.mappingUnverified = true;
        continue;
      }
      if (candidates.length > 1 && !equivalentClipMetadata(candidates)) {
        enriched.warnings.push(`GetClipList metadata is ambiguous for clip: ${event.clipName}`);
        event.mappingUnverified = true;
        event.clipMetadataCandidates = candidates.map(c=>({clipId:c.clip_id ?? c.clipId,
          fileId:clipFileId(c), sourceStartSamples:clipSourceStart(c), sourceEndSamples:clipSourceEnd(c)}));
        // A known file identity is useful for an explicitly approved draft even
        // when the EDL's source position is unverified. Do not choose a Clip ID.
        const ids = new Set(candidates.map(clipFileId));
        if(ids.size === 1 && clipFileId(candidates[0])) {
          const id=clipFileId(candidates[0]), location=fileLocationById.get(id);
          event.fileId=id;
          event.sourceFilePath=location?.path ?? '';
          event.sourceFileOnline=fileIsOnline(location);
          event.sourceFileKnownEndSamples=knownFileEnds.get(id) ?? null;
        }
        continue;
      }

      const clip = candidates[0];
      const sourceStartSamples = clipSourceStart(clip);
      const clipListSourceEndSamples = clipSourceEnd(clip);
      if (sourceStartSamples === null || clipListSourceEndSamples === null) {
        enriched.warnings.push(`GetClipList metadata lacks source range for clip: ${event.clipName}`);
        event.mappingUnverified = true;
        continue;
      }

      const durationSamples = event.durationSamples ?? event.timelineEndSamples - event.timelineStartSamples;
      const sourceEndSamples = sourceStartSamples + durationSamples;
      if (sourceEndSamples > clipListSourceEndSamples) {
        event.mappingUnverified = true;
        enriched.warnings.push(
          `Timeline event exceeds GetClipList source range for clip: ${event.clipName}`
        );
      }

      const fileId = clipFileId(clip);
      const fileLocation = fileLocationById.get(fileId);
      event.fileId = fileId;
      event.sourceFileKnownEndSamples = knownFileEnds.get(fileId) ?? null;
      event.clipId = clip.clip_id ?? clip.clipId ?? "";
      event.clipIsOnline = clipIsOnline(clip);
      event.clipListSourceStartSamples = sourceStartSamples;
      event.clipListSourceEndSamples = clipListSourceEndSamples;
      event.sourceStartSamples = sourceStartSamples;
      event.sourceEndSamples = sourceEndSamples;
      event.sourceRangeBasis = "get_clip_list_start_plus_timeline_duration";
      event.sourceFilePath = fileLocation?.path ?? "";
      event.sourceFileOnline = fileIsOnline(fileLocation);
    }
  }

  return enriched;
}

export function summarizeClipMetadata(metadata) {
  return {
    clips: (metadata.clips ?? []).length,
    fileLocations: (metadata.file_locations ?? metadata.fileLocations ?? []).length
  };
}
