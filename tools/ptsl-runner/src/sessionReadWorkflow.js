import fs from "node:fs";
import { isFailure } from "./ptslClient.js";

const READ_COMMANDS = new Set([
  "GetSessionName", "GetTrackList", "GetClipList", "GetFileLocation", "ExportSessionInfoAsText"
]);

function responseList(body, key, alias) {
  // Protobuf JSON may omit repeated fields when the list is empty.
  const items = body[key] ?? body[alias] ?? [];
  if (!Array.isArray(items)) throw new Error(`Invalid ${key} in Session read response.`);
  return items;
}

function registrationRejected(response) {
  return isFailure(response) && (response.errors?.errors ?? []).some((error) => {
    const message = String(error.command_error_message ?? "").trim();
    // Some hosts report PT_UnknownError with only the offending field name.
    return message === "session_id"
      || /Use the RegisterConnection command first\.?$/i.test(message)
      || /(?:invalid|expired|unknown|missing) (?:client )?session[_ ]id/i.test(message)
      || /(?:client|application) (?:is )?not registered/i.test(message);
  });
}

export class SessionReader {
  constructor(client) {
    this.client = client;
    this.responses = [];
  }

  async read(command, body = {}) {
    if (!READ_COMMANDS.has(command)) throw new Error(`Not a Session read command: ${command}`);
    if (!this.client.sessionId) await this.register();
    let response = await this.client.send(command, body);
    this.responses.push(response);
    if (registrationRejected(response)) {
      await this.register();
      response = await this.client.send(command, body);
      this.responses.push(response);
    }
    if (isFailure(response) || !["TStatus_Completed", "Completed", 3].includes(response.header?.status)) {
      throw new Error(`${command} did not complete: ${JSON.stringify(response.errors)} (${response.header?.status})`);
    }
    return response;
  }

  async register() {
    this.responses.push(await this.client.register());
  }

  async snapshot() {
    const session = await this.read("GetSessionName");
    const tracks = await this.read("GetTrackList", { track_filter: "" });
    if (!session.body.session_name) {
      throw new Error("Session snapshot did not contain a session name and track list.");
    }
    return { session_name: session.body.session_name, track_list: responseList(tracks.body, "track_list") };
  }

  async selectedTracks() {
    const response = await this.read("GetTrackList", {
      track_filter_list: [{ filter: "SelectedExplicitly", is_inverted: false }],
      is_filter_list_additive: true,
      pagination_request: { limit: 0, offset: 0 }
    });
    return { ...response.body, track_list: responseList(response.body, "track_list") };
  }

  async paged(command, key, extra = {}, limit = 500) {
    const items = [];
    for (let offset = 0; ;) {
      const response = await this.read(command, {
        ...extra, pagination_request: { limit, offset }
      });
      const alias = { clips: "clip_list", file_locations: "fileLocations" }[key];
      const pageItems = responseList(response.body, key, alias);
      items.push(...pageItems);
      if (pageItems.length < limit) break;
      const page = response.body.pagination_response ?? response.body.stats ?? {};
      offset += Number(page.limit) || limit;
    }
    return items;
  }

  async exportInfo(outputPath) {
    await this.read("ExportSessionInfoAsText", {
      include_file_list: true, include_clip_list: true, include_markers: true,
      include_plugin_list: false, include_track_edls: true, show_sub_frames: true,
      include_user_timestamps: true, track_list_type: "TListType_AllTracks",
      fade_handling_type: "FHType_ShowCrossfades", text_as_file_format: "TFFormat_UTF8",
      output_type: "ESIOType_File", output_path: outputPath, location_type: "TLType_Samples"
    });
  }

  async exportMetadata() {
    const clips = await this.paged("GetClipList", "clips");
    const file_locations = await this.paged("GetFileLocation", "file_locations", {
      file_filters: ["FLTFilter_AllFiles"]
    });
    return { exported_at: new Date().toISOString(), clips, file_locations };
  }
}

export function summarizeSession(parsed) {
  return {
    sessionName: parsed.metadata.sessionName,
    sampleRate: parsed.metadata.sampleRate,
    onlineFiles: parsed.onlineFiles.length,
    onlineClips: parsed.onlineClips.length,
    tracks: parsed.tracks.length,
    trackEvents: parsed.tracks.reduce((sum, track) => sum + track.events.length, 0),
    audioEvents: parsed.tracks.reduce((sum, track) => sum + track.events.filter(e => !e.isFade).length, 0),
    markers: parsed.markers.length,
    warnings: parsed.warnings.length
  };
}

export async function exportSession(reader, paths, parseFile) {
  const snapshot = await reader.snapshot();
  await reader.exportInfo(paths.info);
  const metadata = await reader.exportMetadata();
  const parsed = parseFile(paths.info);
  const endSession = await reader.read("GetSessionName");
  if (endSession.body.session_name !== snapshot.session_name || parsed.metadata.sessionName !== snapshot.session_name) {
    throw new Error("Pro Tools Session changed during export. Export again from the intended Session.");
  }
  if (snapshot.track_list.length > 0 && parsed.metadata.audioTrackCount > 0 && !parsed.tracks.length) {
    throw new Error("Session Info track listing could not be parsed. Check the export language/format.");
  }
  fs.writeFileSync(paths.metadata, JSON.stringify(metadata, null, 2));
  fs.writeFileSync(paths.parsed, JSON.stringify(parsed, null, 2));
  return { ...snapshot, summary: summarizeSession(parsed) };
}
