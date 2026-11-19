import { executionPolicy } from "./executionPolicy.js";
import fs from "node:fs";
import path from "node:path";
import { inspectAudioFile } from "./audioFileFormat.js";
import { isFailure } from "./ptslClient.js";

const supportedAudioOperations = new Set([
  "AOperations_AddAudio",
  "AOperations_ConvertAudio"
]);

export class CommandPlanExecutionError extends Error {
  constructor(message, partialResult) {
    super(message);
    this.name = "CommandPlanExecutionError";
    this.partialResult = partialResult;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function commandTrackRequest(track) {
  const { channel_count: _channelCount, ...request } = track;
  return request;
}

function normalizedPath(value) {
  return path.resolve(value).normalize("NFC");
}

export function importedFileIds(importResponse, originalPath) {
  const expected = normalizedPath(originalPath);
  const entry = importResponse.body.file_list?.find(
    (item) => typeof item.original_input_path === "string" && normalizedPath(item.original_input_path) === expected
  );
  return (entry?.destination_file_list ?? []).map((file) => file.file_id).filter(Boolean);
}

function requireCompleted(response, commandName) {
  if (isFailure(response)) {
    throw new Error(`${commandName} failed: ${JSON.stringify(response.errors)}`);
  }
  return response;
}

function sessionSampleRate(value) {
  const match = String(value ?? "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function sessionBitDepth(value) {
  if (/32.*float/i.test(String(value))) return { bitDepth: 32, sampleEncoding: "float" };
  const match = String(value ?? "").match(/(16|24|32)/);
  return { bitDepth: match ? Number(match[1]) : 0, sampleEncoding: "integer" };
}

function sessionFileType(value) {
  if (/WAVE/i.test(String(value))) return "WAVE";
  if (/AIFF/i.test(String(value))) return "AIFF";
  return "";
}

function isInsideDirectory(filePath, directoryPath) {
  let source = normalizedPath(filePath);
  let directory = normalizedPath(directoryPath);
  try { source = fs.realpathSync.native(source).normalize("NFC"); } catch {}
  try { directory = fs.realpathSync.native(directory).normalize("NFC"); } catch {}
  const relative = path.relative(directory, source);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function formatMatchesSession(source, session) {
  return source?.fileType === session.fileType
    && source.sampleRate === session.sampleRate
    && source.bitDepth === session.bitDepth
    && source.sampleEncoding === session.sampleEncoding
    && (source.channelCount === 1 || session.isInterleaved === true);
}

export async function readSessionAudioFormat(client, { verifiedPathResponse } = {}) {
  const pathResponse = verifiedPathResponse ?? await client.send("GetSessionPath");
  const formatResponse = await client.send("GetSessionAudioFormat");
  const rateResponse = await client.send("GetSessionSampleRate");
  const depthResponse = await client.send("GetSessionBitDepth");
  const interleavedResponse = await client.send("GetSessionInterleavedState");
  requireCompleted(pathResponse, "GetSessionPath");
  requireCompleted(formatResponse, "GetSessionAudioFormat");
  requireCompleted(rateResponse, "GetSessionSampleRate");
  requireCompleted(depthResponse, "GetSessionBitDepth");
  requireCompleted(interleavedResponse, "GetSessionInterleavedState");

  const sessionPath = pathResponse.body?.session_path?.path ?? pathResponse.body?.sessionPath?.path ?? "";
  if (!sessionPath) {
    throw new Error("GetSessionPath did not return the current .ptx path.");
  }
  const depth = sessionBitDepth(depthResponse.body?.current_setting ?? depthResponse.body?.currentSetting);
  const session = {
    sessionPath,
    audioFilesPath: path.join(path.dirname(sessionPath), "Audio Files"),
    fileType: sessionFileType(formatResponse.body?.current_setting ?? formatResponse.body?.currentSetting),
    sampleRate: sessionSampleRate(rateResponse.body?.sample_rate ?? rateResponse.body?.sampleRate),
    isInterleaved: interleavedResponse.body?.current_setting
      ?? interleavedResponse.body?.currentSetting,
    ...depth
  };
  if (!session.fileType || !session.sampleRate || !session.bitDepth
      || typeof session.isInterleaved !== "boolean") {
    throw new Error(`Could not determine the current Session audio format: ${JSON.stringify(session)}`);
  }
  return {
    session,
    responses: [pathResponse, formatResponse, rateResponse, depthResponse, interleavedResponse]
  };
}

export async function buildSmartImportBatches(client, imports, inspect = inspectAudioFile, options = {}) {
  const { session, responses } = await readSessionAudioFormat(client, options);
  const decisions = imports.map((item) => {
    const sourceFormat = inspect(item.path);
    const matchesSession = formatMatchesSession(sourceFormat, session);
    const alreadyInSession = matchesSession && isInsideDirectory(item.path, session.audioFilesPath);
    const operation = alreadyInSession
      ? "AOperations_AddAudio"
      : matchesSession
        ? "AOperations_CopyAudio"
        : "AOperations_ConvertAudio";
    const reason = alreadyInSession
      ? "already-in-session-audio-files"
      : matchesSession
        ? "format-matches-session"
        : sourceFormat
          ? "format-conversion-required"
          : "source-format-unrecognized";
    return { item, operation, reason, sourceFormat };
  });
  const operationOrder = [
    "AOperations_AddAudio",
    "AOperations_CopyAudio",
    "AOperations_ConvertAudio"
  ];
  const batches = operationOrder
    .map((operation) => ({
      operation,
      items: decisions.filter((decision) => decision.operation === operation).map((decision) => decision.item)
    }))
    .filter((batch) => batch.items.length);
  return { session, responses, decisions, batches };
}

export function reportImportStrategy(strategy) {
  if (!strategy) return null;
  return {
    session: strategy.session,
    decisions: strategy.decisions.map(({ item, operation, reason, sourceFormat }) => ({
      path: item.path,
      operation,
      reason,
      sourceFormat
    })),
    batches: strategy.batches.map((batch) => ({
      operation: batch.operation,
      fileCount: batch.items.length
    }))
  };
}

export function importFailureMessage(response) {
  const failures = response.body?.failure_list ?? response.body?.failureList ?? [];
  if (!failures.length && !isFailure(response)) return "";
  const details = failures.slice(0, 3).map((failure) => (
    `${failure.file_path ?? failure.filePath ?? "Audio file"}: ${failure.failure_message ?? failure.failureMessage ?? "Import failed"}`
  ));
  if (failures.length > details.length) {
    details.push(`...and ${failures.length - details.length} more file(s).`);
  }
  if (!details.length) {
    details.push(JSON.stringify(response.errors));
  }
  return `ImportAudioToClipList failed:\n${details.join("\n")}`;
}

export function createdClipIds(response) {
  return response.body.clip_list?.flatMap((entry) => entry.clip_ids ?? []) ?? [];
}

function trackNamesFromCommandPlan(commandPlan) {
  return [...new Set(
    (commandPlan.createTracks ?? [])
      .map((track) => track.track_name)
      .filter(Boolean)
  )];
}

function trackListFromResponse(response) {
  return response.body?.track_list ?? response.body?.trackList ?? [];
}

export function classifyCommandPlan(commandPlan) {
  const explicitIssues = commandPlan.issues ?? [];
  if (explicitIssues.length) {
    return {
      issues: explicitIssues,
      warnings: explicitIssues.filter((issue) => issue.severity === "warning"),
      fatalIssues: explicitIssues.filter((issue) => issue.severity === "fatal")
    };
  }

  const warningMessages = commandPlan.warnings ?? [];
  const issues = warningMessages.map((message) => ({
    severity: /offline|missing|unsupported/i.test(message) ? "fatal" : "warning",
    code: "legacy-warning",
    message
  }));
  return {
    issues,
    warnings: issues.filter((issue) => issue.severity === "warning"),
    fatalIssues: issues.filter((issue) => issue.severity === "fatal")
  };
}

export function preflightCommandPlan(commandPlan, { allowWarnings = false, automaticPolicy = false, approvePositionWarnings = false } = {}) {
  const classified = classifyCommandPlan(commandPlan);
  const missingPaths = (commandPlan.imports ?? [])
    .filter((item) => item.path && !fs.existsSync(item.path))
    .map((item) => ({
      severity: "fatal",
      code: "path-not-found",
      message: `Source path does not exist: ${item.path}`
    }));

  const policy = automaticPolicy ? executionPolicy([...classified.issues, ...missingPaths], { approvePositionWarnings }) : null;
  const fatalIssues = policy?.fatalIssues ?? [...classified.fatalIssues, ...missingPaths];
  const warnings = classified.warnings;
  const blockers = policy?.blockers ?? [
    ...fatalIssues,
    ...(allowWarnings ? [] : warnings)
  ];

  return {
    okToExecute: blockers.length === 0,
    needsPositionApproval: policy?.needsPositionApproval ?? false,
    positionWarnings: policy?.positionWarnings ?? [],
    reviewIssues: policy?.reviewIssues ?? [],
    blockers,
    fatalIssues,
    warnings,
    summary: {
      imports: commandPlan.summary?.imports ?? commandPlan.imports?.length ?? 0,
      createTracks: commandPlan.summary?.createTracks ?? commandPlan.createTracks?.length ?? 0,
      clipGroups: commandPlan.summary?.clipGroups ?? commandPlan.clipGroups?.length ?? 0,
      fadeGroups: commandPlan.summary?.fadeGroups ?? commandPlan.fadeGroups?.length ?? 0,
      warnings: warnings.length,
      fatalIssues: fatalIssues.length,
      blockers: blockers.length
    }
  };
}

export async function verifyExpectedSession(client, expectedSession) {
  const response = await client.send("GetSessionName");
  const sessionName = response.body?.session_name ?? "";
  if (sessionName !== expectedSession) {
    throw new Error(`Expected Pro Tools session "${expectedSession}", got "${sessionName}".`);
  }
  return {
    expectedSession,
    sessionName
  };
}

export async function verifyDestinationTracksAvailable(client, commandPlan) {
  const plannedDestinationTracks = trackNamesFromCommandPlan(commandPlan);
  if (!plannedDestinationTracks.length) {
    return {
      plannedDestinationTracks,
      existingDestinationTracks: [],
      checkedTrackCount: 0
    };
  }

  const response = await client.send("GetTrackList", { track_filter: "" });
  if (isFailure(response)) {
    throw new Error(`GetTrackList failed before apply: ${JSON.stringify(response.errors)}`);
  }

  const existingTrackNames = new Set(
    trackListFromResponse(response)
      .map((track) => track.name)
      .filter(Boolean)
  );
  const existingDestinationTracks = plannedDestinationTracks.filter((name) => existingTrackNames.has(name));
  if (existingDestinationTracks.length) {
    throw new Error(`Destination tracks already exist: ${existingDestinationTracks.join(", ")}`);
  }

  return {
    plannedDestinationTracks,
    existingDestinationTracks,
    checkedTrackCount: existingTrackNames.size
  };
}

export async function resolveTrackInsertionAnchor(client, commandPlan) {
  if (!trackNamesFromCommandPlan(commandPlan).length) {
    return null;
  }

  const response = await client.send("GetTrackList", {
    track_filter_list: [{ filter: "SelectedExplicitly", is_inverted: false }],
    is_filter_list_additive: true,
    pagination_request: { limit: 0, offset: 0 }
  });
  if (isFailure(response)) {
    throw new Error(`GetTrackList failed while reading the selected track: ${JSON.stringify(response.errors)}`);
  }

  const selectedTracks = trackListFromResponse(response);
  if (!selectedTracks.length) {
    return null;
  }

  const selectedTracksWithIndex = selectedTracks.filter((track) => Number.isFinite(track.index));
  if (!selectedTracksWithIndex.length) {
    throw new Error("Pro Tools did not return an index for the selected insertion track.");
  }

  return selectedTracksWithIndex.reduce((lowestTrack, track) => (
    track.index > lowestTrack.index ? track : lowestTrack
  ));
}

export function materializeCreateAudioClipRequest(group, fileIdByRef) {
  const request = clone(group.createAudioClipRequest);
  for (const clipEntry of request.clip_list ?? []) {
    for (const info of clipEntry.clip_info ?? []) {
      const fileRef = info.file_id_ref;
      const importedIds = fileIdByRef.get(fileRef);
      const fileIds = Array.isArray(importedIds) ? importedIds : importedIds ? [importedIds] : [];
      if (!fileIds.length) {
        throw new Error(`No imported file_id for ${fileRef}`);
      }
      if (fileIds.length === 1) {
        info.file_id = fileIds[0];
      } else {
        const channelNames = {
          SChannel_Mono: 1,
          SChannel_Left: 1,
          SChannel_Right: 2
        };
        const sourceChannel = info.src_channel?.index
          ?? channelNames[info.src_channel?.name]
          ?? 1;
        info.file_id = fileIds[sourceChannel - 1];
        if (!info.file_id) {
          throw new Error(`No imported file_id for source channel ${sourceChannel} of ${fileRef}`);
        }
        info.src_channel = { name: "SChannel_Mono" };
      }
      delete info.file_id_ref;
    }
  }
  return request;
}

export function materializeSpotRequest(group, clipIds) {
  const request = clone(group.spotClipsByIdRequest);
  request.src_clips = clipIds;
  delete request.src_clips_ref;
  return request;
}

export async function executeCommandPlan(commandPlan, client, {
  allowWarnings = false,
  audioOperation = "AOperations_AddAudio",
  automaticPolicy = false,
  approvePositionWarnings = false
} = {}) {
  if (!supportedAudioOperations.has(audioOperation)) {
    throw new Error(`Unsupported audio operation: ${audioOperation}`);
  }
  const preflight = preflightCommandPlan(commandPlan, { allowWarnings, automaticPolicy, approvePositionWarnings });
  if (!preflight.okToExecute) {
    throw new Error(`Command plan blocked:\n${preflight.blockers.map((issue) => `- ${issue.message}`).join("\n")}`);
  }

  const results = [];
  const createdClipIdsByName = new Map();
  const fileIdByRef = new Map();
  let trackPreflight = null;
  let trackInsertion = null;
  let importStrategy = null;

  try {
    trackPreflight = await verifyDestinationTracksAvailable(client, commandPlan);
    trackInsertion = await resolveTrackInsertionAnchor(client, commandPlan);

    if ((commandPlan.imports ?? []).length) {
      const batches = audioOperation === "AOperations_AddAudio"
        ? [{ operation: audioOperation, items: commandPlan.imports }]
        : (importStrategy = await buildSmartImportBatches(client, commandPlan.imports)).batches;
      if (importStrategy) {
        results.push(...importStrategy.responses);
      }

      for (const batch of batches) {
        const request = {
          file_list: batch.items.map((item) => item.path),
          audio_operations: batch.operation,
          ...(batch.operation === "AOperations_AddAudio"
            ? {}
            : { destination_path: importStrategy.session.audioFilesPath })
        };
        const importResponse = await client.send("ImportAudioToClipList", request);
        results.push(importResponse);
        const failure = importFailureMessage(importResponse);
        if (failure) {
          throw new Error(failure);
        }

        for (const item of batch.items) {
          const fileIds = importedFileIds(importResponse, item.path);
          if (!fileIds.length) {
            throw new Error(`ImportAudioToClipList did not return file_id for ${item.path}`);
          }
          fileIdByRef.set(item.path, fileIds);
          if (item.sourceFile) {
            fileIdByRef.set(item.sourceFile, fileIds);
          }
        }
      }
    }

    for (const track of commandPlan.createTracks ?? []) {
      const request = commandTrackRequest(track);
      if (trackInsertion) {
        request.insertion_point_position = "TIPoint_After";
        request.insertion_point_track_name = trackInsertion.name;
      } else {
        request.insertion_point_position = "TIPoint_Last";
      }
      results.push(await client.send("CreateNewTracks", request));
      if (trackInsertion) {
        trackInsertion = { name: track.track_name, index: trackInsertion.index + 1 };
      }
    }

    for (const group of commandPlan.clipGroups ?? []) {
      const createResponse = await client.send(
        "CreateAudioClips",
        materializeCreateAudioClipRequest(group, fileIdByRef)
      );
      results.push(createResponse);

      const clipIds = createdClipIds(createResponse);
      if (!clipIds.length) {
        throw new Error(`CreateAudioClips returned no clip IDs for ${group.name}`);
      }
      createdClipIdsByName.set(group.name, clipIds);

      const spotResponse = await client.send("SpotClipsByID", materializeSpotRequest(group, clipIds));
      results.push(spotResponse);
      if (isFailure(spotResponse)) throw new Error(`SpotClipsByID failed for ${group.name}: ${JSON.stringify(spotResponse.errors)}`);
    }

    for (const group of commandPlan.fadeGroups ?? []) {
      for (const [command, request] of [
        ["SelectTracksByName", group.selectTracksByNameRequest],
        ["SetTimelineSelection", group.setTimelineSelectionRequest],
        ["CreateFadesBasedOnPreset", group.createFadesBasedOnPresetRequest]
      ]) {
        const response = await client.send(command, request);
        results.push(response);
        if (isFailure(response)) {
          throw new Error(`${command} failed on ${group.destinationTrack} at samples ${group.timelineStartSamples}–${group.timelineEndSamples}: ${JSON.stringify(response.errors)}`);
        }
      }
    }
  } catch (error) {
    throw new CommandPlanExecutionError(error.message, {
      preflight,
      trackPreflight,
      trackInsertion,
      importStrategy: reportImportStrategy(importStrategy),
      createdClipIdsByName: Object.fromEntries(createdClipIdsByName),
      results,
      failedCommands: results.filter(isFailure).length
    });
  }

  return {
    preflight,
    trackPreflight,
    trackInsertion,
    importStrategy: reportImportStrategy(importStrategy),
    createdClipIdsByName: Object.fromEntries(createdClipIdsByName),
    results,
    failedCommands: results.filter(isFailure).length
  };
}
