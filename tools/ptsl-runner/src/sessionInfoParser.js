import fs from "node:fs";

const SECTION_KEYS = {
  ONLINEFILESINSESSION: "onlineFiles",
  OFFLINEFILESINSESSION: "offlineFiles",
  ONLINECLIPSINSESSION: "onlineClips",
  OFFLINECLIPSINSESSION: "offlineClips",
  TRACKLISTING: "tracks",
  MARKERSLISTING: "markers",
  工程中在线的文件: "onlineFiles",
  工程中的在线文件: "onlineFiles",
  项目中的离线文件: "offlineFiles",
  工程中的离线文件: "offlineFiles",
  工程中的在线片段: "onlineClips",
  项目中的离线片段: "offlineClips",
  工程中的离线片段: "offlineClips",
  轨道列表: "tracks",
  标记点列表: "markers"
};

function compactKey(value) {
  return String(value).replace(/\s+/g, "").toUpperCase();
}

function sectionFromLine(line) {
  return SECTION_KEYS[compactKey(line)] ?? "";
}

function splitColumns(line) {
  return line.split("\t").map((part) => part.trim());
}

function labeledLine(line) {
  const match = line.match(/^([^：:\t]+)[：:]\t?(.*)$/);
  return match ? { key: match[1].trim(), value: match[2].trim() } : null;
}

function parseSampleNumber(value) {
  const normalized = String(value ?? "").replace(/[,\s]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value) {
  const normalized = String(value ?? "").replace(/[,\s]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHeaderField(metadata, key, value) {
  const normalizedKey = key.trim().toUpperCase();
  const trimmedValue = value.trim();
  metadata.raw[normalizedKey] = trimmedValue;

  if (normalizedKey === "SESSION NAME" || normalizedKey === "工程名") {
    metadata.sessionName = trimmedValue;
  } else if (normalizedKey === "SAMPLE RATE" || normalizedKey === "采样率") {
    metadata.sampleRate = Number.parseFloat(trimmedValue);
  } else if (normalizedKey === "BIT DEPTH" || normalizedKey === "比特精度") {
    metadata.bitDepth = trimmedValue;
  } else if (normalizedKey === "SESSION START TIMECODE" || normalizedKey === "工程起始时间码") {
    metadata.sessionStartTimecode = trimmedValue;
  } else if (normalizedKey === "TIMECODE FORMAT" || normalizedKey === "时间码格式") {
    metadata.timecodeFormat = trimmedValue;
  } else if (normalizedKey === "# OF AUDIO TRACKS" || normalizedKey === "音频轨道数") {
    metadata.audioTrackCount = parseInteger(trimmedValue);
  } else if (normalizedKey === "# OF AUDIO CLIPS" || normalizedKey === "音频片段数") {
    metadata.audioClipCount = parseInteger(trimmedValue);
  } else if (normalizedKey === "# OF AUDIO FILES" || normalizedKey === "音频文件数") {
    metadata.audioFileCount = parseInteger(trimmedValue);
  }
}

function parseSourceChannel(value) {
  const match = String(value ?? "").match(/\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function parseTrackName(rawTrackName) {
  const match = rawTrackName.match(/^(.*)\s+\(([^)]+)\)$/);
  if (!match) {
    return { name: rawTrackName.trim(), declaredFormat: "" };
  }
  return {
    name: match[1].trim(),
    declaredFormat: match[2].trim()
  };
}

function parseUserDelaySamples(value) {
  const match = String(value ?? "").match(/(-?[\d,]+)\s*(?:Samples|采样)/i);
  return match ? parseSampleNumber(match[1]) : null;
}

function eventTypeFromClipName(clipName) {
  const normalized = clipName.trim().toLowerCase();
  if (normalized === "(fade in)" || normalized === "(淡入)") {
    return "fade-in";
  }
  if (normalized === "(fade out)" || normalized === "(淡出)") {
    return "fade-out";
  }
  if (normalized === "(cross fade)" || normalized === "(crossfade)" || normalized === "(交叠淡变)") {
    return "crossfade";
  }
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    return "synthetic";
  }
  return "audio";
}

function isMutedState(state) {
  const normalized = String(state ?? "").trim().toLowerCase();
  return normalized === "muted" || normalized === "静音";
}

function isHiddenState(state) {
  return /\bHidden\b/i.test(String(state ?? "")) || String(state ?? "").includes("隐藏");
}

function isInactiveState(state) {
  return /\bInactive\b/i.test(String(state ?? "")) || String(state ?? "").includes("未激活");
}

function parseTrackEvent(line, track, warnings, lineNumber) {
  const columns = splitColumns(line);
  if (columns.length < 8) {
    warnings.push(`Line ${lineNumber}: track event has ${columns.length} columns; expected at least 8.`);
    return null;
  }

  const channel = parseInteger(columns[0]);
  const event = parseInteger(columns[1]);
  const clipName = columns[2];
  const timelineStartSamples = parseSampleNumber(columns[3]);
  const timelineEndSamples = parseSampleNumber(columns[4]);
  const durationSamples = parseSampleNumber(columns[5]);
  const timestampSamples = parseSampleNumber(columns[6]);
  const state = columns.slice(7).join(" ").trim();
  const type = eventTypeFromClipName(clipName);

  if (channel === null || event === null || timelineStartSamples === null || timelineEndSamples === null) {
    warnings.push(`Line ${lineNumber}: could not parse numeric fields for track ${track.name}.`);
    return null;
  }

  return {
    trackName: track.name,
    trackRawName: track.rawName,
    channel,
    event,
    clipName,
    timelineStartSamples,
    timelineEndSamples,
    durationSamples,
    timestampSamples,
    state,
    type,
    isFade: type !== "audio",
    isMuted: isMutedState(state),
    isOnHiddenTrack: Boolean(track.isHidden),
    isOnInactiveTrack: Boolean(track.isInactive),
    sourceFile: null,
    sourceChannel: null,
    sourceStartSamples: type === "audio" ? timestampSamples : null,
    sourceEndSamples: type === "audio" && timestampSamples !== null && durationSamples !== null
      ? timestampSamples + durationSamples
      : null,
    sourceRangeBasis: type === "audio" ? "track_edl_timestamp" : "none"
  };
}

function attachClipSources(session) {
  const clipByName = new Map();
  for (const clip of session.onlineClips) {
    if (!clipByName.has(clip.clipName)) {
      clipByName.set(clip.clipName, []);
    }
    clipByName.get(clip.clipName).push(clip);
  }

  for (const track of session.tracks) {
    let maxChannel = 0;
    for (const event of track.events) {
      maxChannel = Math.max(maxChannel, event.channel ?? 0);
      const candidates = clipByName.get(event.clipName) ?? [];
      const clip = chooseClipSource(candidates, event);
      if (clip) {
        event.sourceFile = clip.sourceFile;
        event.sourceChannel = clip.sourceChannel ?? event.channel;
      } else if (!event.isFade && candidates.length) {
        session.warnings.push(`Ambiguous online clip-list source for clip: ${event.clipName}`);
      } else if (!event.isFade) {
        session.warnings.push(`No online clip-list source found for clip: ${event.clipName}`);
      }
    }
    track.channelCount = maxChannel;
    track.format = track.declaredFormat || (maxChannel > 1 ? `${maxChannel}ch` : "Mono");
  }
}

function clipSourceKey(clip) {
  return `${clip.sourceFile ?? ""}|${clip.sourceChannel ?? ""}`;
}

function chooseClipSource(candidates, event) {
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const uniqueSourceKeys = new Set(candidates.map(clipSourceKey));
  if (uniqueSourceKeys.size === 1) {
    return candidates[0];
  }

  const channelMatches = candidates.filter((clip) => {
    return clip.sourceChannel === null || clip.sourceChannel === event.channel;
  });
  if (channelMatches.length) {
    const channelSourceKeys = new Set(channelMatches.map(clipSourceKey));
    if (channelSourceKeys.size === 1) {
      return channelMatches[0];
    }
  }

  return null;
}

function parseDelimitedSectionLine(section, line) {
  const columns = splitColumns(line);
  if (!columns[0] || ["Filename", "CLIP NAME", "文件名", "片段名称"].includes(columns[0])) {
    return null;
  }

  if (section === "onlineFiles" || section === "offlineFiles") {
    return {
      filename: columns[0],
      location: columns[1] ?? ""
    };
  }

  if (section === "onlineClips" || section === "offlineClips") {
    return {
      clipName: columns[0],
      sourceFile: columns[1] ?? "",
      sourceChannel: parseSourceChannel(columns[2])
    };
  }

  return null;
}

function parseMarkerLine(line) {
  const columns = splitColumns(line);
  if (!columns[0] || columns[0] === "#") {
    return null;
  }
  return {
    number: parseInteger(columns[0]),
    locationSamples: parseSampleNumber(columns[1]),
    timeReferenceSamples: parseSampleNumber(columns[2]),
    units: columns[3] ?? "",
    name: columns[4] ?? "",
    trackName: columns[5] ?? "",
    trackType: columns[6] ?? "",
    comments: columns.slice(7).join(" ").trim()
  };
}

export function parseSessionInfoText(text) {
  const session = {
    metadata: { raw: {} },
    onlineFiles: [],
    offlineFiles: [],
    onlineClips: [],
    offlineClips: [],
    tracks: [],
    markers: [],
    warnings: []
  };

  const lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let section = "";
  let currentTrack = null;
  let inTrackEvents = false;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const nextSection = sectionFromLine(trimmed);
    if (nextSection) {
      section = nextSection;
      currentTrack = null;
      inTrackEvents = false;
      return;
    }

    if (!section) {
      const header = labeledLine(line);
      if (header) {
        parseHeaderField(session.metadata, header.key, header.value);
      }
      return;
    }

    if (section === "tracks") {
      const trackHeader = labeledLine(line);
      if (trackHeader && ["TRACK NAME", "轨道名"].includes(trackHeader.key.toUpperCase())) {
        const rawName = trackHeader.value;
        const parsedName = parseTrackName(rawName);
        currentTrack = {
          name: parsedName.name,
          rawName,
          declaredFormat: parsedName.declaredFormat,
          format: parsedName.declaredFormat,
          comments: "",
          userDelaySamples: null,
          state: "",
          isHidden: false,
          isInactive: false,
          channelCount: 0,
          events: []
        };
        session.tracks.push(currentTrack);
        inTrackEvents = false;
        return;
      }

      if (!currentTrack) {
        return;
      }

      const field = labeledLine(line);
      if (field && !inTrackEvents) {
        const key = field.key.toUpperCase();
        const value = field.value;
        if (key === "COMMENTS" || key === "注释") {
          currentTrack.comments = value;
        } else if (key === "USER DELAY" || key === "用户延时") {
          currentTrack.userDelaySamples = parseUserDelaySamples(value);
        } else if (key === "STATE" || key === "状态") {
          currentTrack.state = value;
          currentTrack.isHidden = isHiddenState(value);
          currentTrack.isInactive = isInactiveState(value);
        }
        return;
      }

      if (trimmed.startsWith("CHANNEL") || trimmed.startsWith("通道")) {
        inTrackEvents = true;
        return;
      }

      if (inTrackEvents && /^\d/.test(trimmed)) {
        const event = parseTrackEvent(line, currentTrack, session.warnings, lineNumber);
        if (event) {
          currentTrack.events.push(event);
        }
      }
      return;
    }

    if (section === "markers") {
      const marker = parseMarkerLine(line);
      if (marker) {
        session.markers.push(marker);
      }
      return;
    }

    const parsed = parseDelimitedSectionLine(section, line);
    if (parsed) {
      session[section].push(parsed);
    }
  });

  attachClipSources(session);
  if ((session.metadata.audioTrackCount ?? 0) > 0 && session.tracks.length === 0) {
    session.warnings.push(
      `Session Info declares ${session.metadata.audioTrackCount} audio track(s), but no track listing could be parsed.`
    );
  }
  return session;
}

export function parseSessionInfoFile(filePath) {
  return parseSessionInfoText(fs.readFileSync(filePath, "utf8"));
}

export function findTrack(session, trackName) {
  return session.tracks.find((track) => track.name === trackName || track.rawName === trackName) ?? null;
}

export function audioEventsForTrack(session, trackName, {
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
  return track.events.filter((event) => {
    if (!includeFades && event.isFade) {
      return false;
    }
    if (!includeMuted && event.isMuted) {
      return false;
    }
    if (channel !== null && event.channel !== channel) {
      return false;
    }
    return true;
  });
}
