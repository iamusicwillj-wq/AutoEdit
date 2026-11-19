import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSmartImportBatches,
  executeCommandPlan,
  materializeCreateAudioClipRequest,
  materializeSpotRequest,
  preflightCommandPlan,
  resolveTrackInsertionAnchor,
  verifyDestinationTracksAvailable,
  verifyExpectedSession
} from "../src/applyEngine.js";

function writeWaveFixture(filePath, { sampleRate, bitDepth }) {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2 * (bitDepth / 8), 28);
  buffer.writeUInt16LE(2 * (bitDepth / 8), 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  fs.writeFileSync(filePath, buffer);
}

async function executeWithAudioOperation(t, audioOperation) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoedit-apply-test-"));
  const sourcePath = path.join(temporaryRoot, "source.wav");
  fs.writeFileSync(sourcePath, "fixture");
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const calls = [];
  const client = {
    async send(command, body) {
      calls.push({ command, body });
      if (command === "GetTrackList") {
        return { header: { status: "TStatus_Completed" }, body: { track_list: [] } };
      }
      if (command === "GetSessionPath") {
        return {
          header: { status: "TStatus_Completed" },
          body: { session_path: { path: path.join(temporaryRoot, "Edit Session.ptx") } }
        };
      }
      if (command === "GetSessionAudioFormat") {
        return { header: { status: "TStatus_Completed" }, body: { current_setting: "SAF_WAVE" } };
      }
      if (command === "GetSessionSampleRate") {
        return { header: { status: "TStatus_Completed" }, body: { sample_rate: "SR_48000" } };
      }
      if (command === "GetSessionBitDepth") {
        return { header: { status: "TStatus_Completed" }, body: { current_setting: "BDepth_24" } };
      }
      if (command === "GetSessionInterleavedState") {
        return { header: { status: "TStatus_Completed" }, body: { current_setting: true } };
      }
      if (command === "ImportAudioToClipList") {
        return {
          header: { status: "TStatus_Completed" },
          body: {
            file_list: [{
              original_input_path: sourcePath,
              destination_file_list: [{ file_id: "file-1" }]
            }]
          }
        };
      }
      return { header: { status: "TStatus_Completed" }, body: {} };
    }
  };

  await executeCommandPlan({
    imports: [{ path: sourcePath }],
    createTracks: [],
    clipGroups: [],
    fadeGroups: [],
    issues: []
  }, client, audioOperation ? { audioOperation } : undefined);

  return calls.find((call) => call.command === "ImportAudioToClipList").body.audio_operations;
}

test("executeCommandPlan links source audio by default", async (t) => {
  assert.equal(await executeWithAudioOperation(t), "AOperations_AddAudio");
});

test("executeCommandPlan can convert audio to the session format", async (t) => {
  assert.equal(
    await executeWithAudioOperation(t, "AOperations_ConvertAudio"),
    "AOperations_ConvertAudio"
  );
});

test("buildSmartImportBatches classifies link, copy, and convert files", async () => {
  const sessionPath = "/tmp/Edit Session/Edit Session.ptx";
  const client = {
    async send(command) {
      const responses = {
        GetSessionPath: { session_path: { path: sessionPath } },
        GetSessionAudioFormat: { current_setting: "SAF_WAVE" },
        GetSessionSampleRate: { sample_rate: "SR_48000" },
        GetSessionBitDepth: { current_setting: "BDepth_24" },
        GetSessionInterleavedState: { current_setting: true }
      };
      return { header: { status: "TStatus_Completed" }, body: responses[command] };
    }
  };
  const formats = new Map([
    ["/tmp/Edit Session/Audio Files/in-session.wav", {
      fileType: "WAVE", channelCount: 2, sampleRate: 48000, bitDepth: 24, sampleEncoding: "integer"
    }],
    ["/tmp/Edit Session/Audio Files/in-session-different.wav", {
      fileType: "WAVE", channelCount: 2, sampleRate: 96000, bitDepth: 24, sampleEncoding: "integer"
    }],
    ["/tmp/Recording/matching.wav", {
      fileType: "WAVE", channelCount: 2, sampleRate: 48000, bitDepth: 24, sampleEncoding: "integer"
    }],
    ["/tmp/Recording/different.wav", {
      fileType: "WAVE", channelCount: 2, sampleRate: 96000, bitDepth: 24, sampleEncoding: "integer"
    }]
  ]);
  const imports = [...formats.keys()].map((filePath) => ({ path: filePath }));

  const strategy = await buildSmartImportBatches(client, imports, (filePath) => formats.get(filePath));

  assert.equal(strategy.session.audioFilesPath, "/tmp/Edit Session/Audio Files");
  assert.deepEqual(strategy.decisions.map(({ operation, reason }) => ({ operation, reason })), [
    {
      operation: "AOperations_AddAudio",
      reason: "already-in-session-audio-files"
    },
    {
      operation: "AOperations_ConvertAudio",
      reason: "format-conversion-required"
    },
    {
      operation: "AOperations_CopyAudio",
      reason: "format-matches-session"
    },
    {
      operation: "AOperations_ConvertAudio",
      reason: "format-conversion-required"
    }
  ]);
  assert.deepEqual(strategy.batches.map((batch) => ({
    operation: batch.operation,
    paths: batch.items.map((item) => item.path)
  })), [
    {
      operation: "AOperations_AddAudio",
      paths: ["/tmp/Edit Session/Audio Files/in-session.wav"]
    },
    {
      operation: "AOperations_CopyAudio",
      paths: ["/tmp/Recording/matching.wav"]
    },
    {
      operation: "AOperations_ConvertAudio",
      paths: [
        "/tmp/Edit Session/Audio Files/in-session-different.wav",
        "/tmp/Recording/different.wav"
      ]
    }
  ]);
});

test("smart import safely converts an unrecognized audio format", async () => {
  const client = {
    async send(command) {
      const responses = {
        GetSessionPath: { session_path: { path: "/tmp/Edit Session/Edit Session.ptx" } },
        GetSessionAudioFormat: { current_setting: "SAFormat_WAVE" },
        GetSessionSampleRate: { sample_rate: "SRate_48000" },
        GetSessionBitDepth: { current_setting: "BDepth_24" },
        GetSessionInterleavedState: { current_setting: true }
      };
      return { header: { status: "TStatus_Completed" }, body: responses[command] };
    }
  };

  const strategy = await buildSmartImportBatches(
    client,
    [{ path: "/tmp/Recording/unrecognized.audio" }],
    () => null
  );

  assert.equal(strategy.decisions[0].operation, "AOperations_ConvertAudio");
  assert.equal(strategy.decisions[0].reason, "source-format-unrecognized");
  assert.equal(strategy.decisions[0].sourceFormat, null);
});

test("smart import converts multichannel files for a non-interleaved Session", async () => {
  const client = {
    async send(command) {
      const responses = {
        GetSessionPath: { session_path: { path: "/tmp/Edit Session/Edit Session.ptx" } },
        GetSessionAudioFormat: { current_setting: "SAFormat_WAVE" },
        GetSessionSampleRate: { sample_rate: "SRate_48000" },
        GetSessionBitDepth: { current_setting: "BDepth_24" },
        GetSessionInterleavedState: { current_setting: false }
      };
      return { header: { status: "TStatus_Completed" }, body: responses[command] };
    }
  };
  const imports = [
    { path: "/tmp/Recording/mono.wav" },
    { path: "/tmp/Recording/stereo.wav" }
  ];

  const strategy = await buildSmartImportBatches(client, imports, (filePath) => ({
    fileType: "WAVE",
    channelCount: filePath.endsWith("mono.wav") ? 1 : 2,
    sampleRate: 48000,
    bitDepth: 24,
    sampleEncoding: "integer"
  }));

  assert.deepEqual(strategy.decisions.map(({ operation }) => operation), [
    "AOperations_CopyAudio",
    "AOperations_ConvertAudio"
  ]);
});

test("smart session-format import executes separate add, copy, and convert batches", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoedit-smart-import-test-"));
  const audioFilesPath = path.join(root, "Edit Session", "Audio Files");
  const recordingPath = path.join(root, "Recording");
  fs.mkdirSync(audioFilesPath, { recursive: true });
  fs.mkdirSync(recordingPath, { recursive: true });
  const files = [
    path.join(audioFilesPath, "in-session.wav"),
    path.join(recordingPath, "matching.wav"),
    path.join(recordingPath, "different.wav")
  ];
  writeWaveFixture(files[0], { sampleRate: 48000, bitDepth: 24 });
  writeWaveFixture(files[1], { sampleRate: 48000, bitDepth: 24 });
  writeWaveFixture(files[2], { sampleRate: 96000, bitDepth: 24 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const importRequests = [];
  const client = {
    async send(command, body) {
      if (command === "GetTrackList") {
        return { header: { status: "TStatus_Completed" }, body: { track_list: [] } };
      }
      const sessionBodies = {
        GetSessionPath: { session_path: { path: path.join(root, "Edit Session", "Edit Session.ptx") } },
        GetSessionAudioFormat: { current_setting: "SAF_WAVE" },
        GetSessionSampleRate: { sample_rate: "SR_48000" },
        GetSessionBitDepth: { current_setting: "BDepth_24" },
        GetSessionInterleavedState: { current_setting: true }
      };
      if (sessionBodies[command]) {
        return { header: { status: "TStatus_Completed" }, body: sessionBodies[command] };
      }
      if (command === "ImportAudioToClipList") {
        importRequests.push(body);
        return {
          header: { status: "TStatus_Completed" },
          body: {
            file_list: body.file_list.map((filePath, index) => ({
              original_input_path: filePath,
              destination_file_list: [{ file_id: `${body.audio_operations}-${index}` }]
            })),
            failure_list: []
          }
        };
      }
      return { header: { status: "TStatus_Completed" }, body: {} };
    }
  };

  await executeCommandPlan({
    imports: files.map((filePath) => ({ path: filePath })),
    createTracks: [],
    clipGroups: [],
    fadeGroups: [],
    issues: []
  }, client, { audioOperation: "AOperations_ConvertAudio" });

  assert.deepEqual(importRequests, [
    {
      file_list: [files[0]],
      audio_operations: "AOperations_AddAudio"
    },
    {
      file_list: [files[1]],
      audio_operations: "AOperations_CopyAudio",
      destination_path: audioFilesPath
    },
    {
      file_list: [files[2]],
      audio_operations: "AOperations_ConvertAudio",
      destination_path: audioFilesPath
    }
  ]);
});

test("import failure reports the Pro Tools failure_list reason", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoedit-import-failure-test-"));
  const sourcePath = path.join(root, "source.wav");
  fs.writeFileSync(sourcePath, "fixture");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command === "GetTrackList") {
        return { header: { status: "TStatus_Completed" }, body: { track_list: [] } };
      }
      if (command === "ImportAudioToClipList") {
        return {
          header: { status: "TStatus_Failed" },
          body: {
            file_list: [],
            failure_list: [{
              file_path: sourcePath,
              failure_message: "The audio file could not be added into the session."
            }]
          },
          errors: { errors: [{ command_error_message: "No audio files were imported." }] }
        };
      }
      return { header: { status: "TStatus_Completed" }, body: {} };
    }
  };

  await assert.rejects(
    executeCommandPlan({
      imports: [{ path: sourcePath }],
      createTracks: [{ track_name: "SHOULD_NOT_BE_CREATED", number_of_tracks: 1 }],
      clipGroups: [],
      fadeGroups: [],
      issues: []
    }, client),
    /The audio file could not be added into the session/
  );
  assert.equal(commands.includes("CreateNewTracks"), false);
});

test("executeCommandPlan rejects unsupported audio operations", async () => {
  await assert.rejects(
    executeCommandPlan({ imports: [], issues: [] }, { send() {} }, {
      audioOperation: "AOperations_CopyAudio"
    }),
    /Unsupported audio operation/
  );
});

test("preflight blocks warnings unless explicitly allowed", () => {
  const commandPlan = {
    imports: [],
    createTracks: [],
    clipGroups: [],
    fadeGroups: [{ destinationTrack: "REAL_ST" }],
    issues: [
      {
        severity: "warning",
        code: "inactive-source-track",
        message: "Source track is inactive: E"
      }
    ]
  };

  assert.equal(preflightCommandPlan(commandPlan).okToExecute, false);
  assert.equal(preflightCommandPlan(commandPlan, { allowWarnings: true }).okToExecute, true);
  assert.equal(preflightCommandPlan(commandPlan, { allowWarnings: true }).summary.fadeGroups, 1);
});

test("preflight blocks fatal issues even when warnings are allowed", () => {
  const commandPlan = {
    imports: [],
    createTracks: [],
    clipGroups: [],
    issues: [
      {
        severity: "fatal",
        code: "offline-source-file",
        message: "Source file is offline"
      }
    ]
  };

  assert.equal(preflightCommandPlan(commandPlan, { allowWarnings: true }).okToExecute, false);
});

test("materializes file refs and created clip refs into PTSL requests", () => {
  const group = {
    name: "CUE01_REAL_ST_001",
    createAudioClipRequest: {
      clip_list: [
        {
          name: "CUE01_REAL_ST_001",
          channel_format: "SFormat_Stereo",
          clip_info: [
            { file_id_ref: "/tmp/take.wav", src_channel: { index: 1 } },
            { file_id_ref: "/tmp/take.wav", src_channel: { index: 2 } }
          ]
        }
      ]
    },
    spotClipsByIdRequest: {
      src_clips_ref: "created:CUE01_REAL_ST_001",
      dst_track_name: "REAL_ST"
    }
  };

  const fileIdByRef = new Map([["/tmp/take.wav", "file-123"]]);
  const createRequest = materializeCreateAudioClipRequest(group, fileIdByRef);
  assert.equal(createRequest.clip_list[0].clip_info[0].file_id, "file-123");
  assert.equal("file_id_ref" in createRequest.clip_list[0].clip_info[0], false);

  const spotRequest = materializeSpotRequest(group, ["clip-l", "clip-r"]);
  assert.deepEqual(spotRequest.src_clips, ["clip-l", "clip-r"]);
  assert.equal("src_clips_ref" in spotRequest, false);
});

test("materializes split multi-mono imports by source channel", () => {
  const group = {
    createAudioClipRequest: {
      clip_list: [{
        channel_format: "SFormat_Stereo",
        clip_info: [
          {
            file_id_ref: "/tmp/take.wav",
            src_channel: { name: "SChannel_Left" },
            dst_channel: { name: "SChannel_Left" }
          },
          {
            file_id_ref: "/tmp/take.wav",
            src_channel: { name: "SChannel_Right" },
            dst_channel: { name: "SChannel_Right" }
          }
        ]
      }]
    }
  };

  const request = materializeCreateAudioClipRequest(
    group,
    new Map([["/tmp/take.wav", ["file-left", "file-right"]]])
  );

  assert.deepEqual(request.clip_list[0].clip_info.map((info) => ({
    fileId: info.file_id,
    sourceChannel: info.src_channel,
    destinationChannel: info.dst_channel
  })), [
    {
      fileId: "file-left",
      sourceChannel: { name: "SChannel_Mono" },
      destinationChannel: { name: "SChannel_Left" }
    },
    {
      fileId: "file-right",
      sourceChannel: { name: "SChannel_Mono" },
      destinationChannel: { name: "SChannel_Right" }
    }
  ]);
});

test("verifyExpectedSession accepts the intended Pro Tools session", async () => {
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command);
      return { body: { session_name: "AutoEdit Edit Test" } };
    }
  };

  assert.deepEqual(
    await verifyExpectedSession(client, "AutoEdit Edit Test"),
    {
      expectedSession: "AutoEdit Edit Test",
      sessionName: "AutoEdit Edit Test"
    }
  );
  assert.deepEqual(calls, ["GetSessionName"]);
});

test("verifyExpectedSession rejects an unexpected Pro Tools session", async () => {
  const client = {
    async send() {
      return { body: { session_name: "Work Session" } };
    }
  };

  await assert.rejects(
    () => verifyExpectedSession(client, "AutoEdit Edit Test"),
    /Expected Pro Tools session "AutoEdit Edit Test", got "Work Session"/
  );
});

test("verifyDestinationTracksAvailable accepts missing destination tracks", async () => {
  const client = {
    async send(command, body) {
      assert.equal(command, "GetTrackList");
      assert.deepEqual(body, { track_filter: "" });
      return {
        header: { status: "TStatus_Completed" },
        body: {
          track_list: [
            { name: "EDIT_DEMO_ST" }
          ]
        }
      };
    }
  };
  const commandPlan = {
    createTracks: [
      { track_name: "CONF_MAIN_ST" },
      { track_name: "CONF_ROOM_ST" }
    ]
  };

  assert.deepEqual(
    await verifyDestinationTracksAvailable(client, commandPlan),
    {
      plannedDestinationTracks: ["CONF_MAIN_ST", "CONF_ROOM_ST"],
      existingDestinationTracks: [],
      checkedTrackCount: 1
    }
  );
});

test("verifyDestinationTracksAvailable rejects existing destination tracks", async () => {
  const client = {
    async send() {
      return {
        header: { status: "TStatus_Completed" },
        body: {
          track_list: [
            { name: "CONF_MAIN_ST" },
            { name: "EDIT_DEMO_ST" }
          ]
        }
      };
    }
  };
  const commandPlan = {
    createTracks: [
      { track_name: "CONF_MAIN_ST" },
      { track_name: "CONF_ROOM_ST" }
    ]
  };

  await assert.rejects(
    () => verifyDestinationTracksAvailable(client, commandPlan),
    /Destination tracks already exist: CONF_MAIN_ST/
  );
});

test("resolveTrackInsertionAnchor uses the lowest explicitly selected track", async () => {
  const client = {
    async send(command, body) {
      assert.equal(command, "GetTrackList");
      assert.deepEqual(body, {
        track_filter_list: [{ filter: "SelectedExplicitly", is_inverted: false }],
        is_filter_list_additive: true,
        pagination_request: { limit: 0, offset: 0 }
      });
      return {
        header: { status: "TStatus_Completed" },
        body: {
          track_list: [
            { name: "Anchor A", index: 3 },
            { name: "Anchor B", index: 11 }
          ]
        }
      };
    }
  };

  assert.deepEqual(
    await resolveTrackInsertionAnchor(client, {
      createTracks: [{ track_name: "CONF_MAIN" }]
    }),
    { name: "Anchor B", index: 11 }
  );
});

test("resolveTrackInsertionAnchor returns no anchor when no track is selected", async () => {
  const client = {
    async send() {
      return { header: { status: "TStatus_Completed" }, body: { track_list: [] } };
    }
  };

  assert.equal(
    await resolveTrackInsertionAnchor(client, {
      createTracks: [{ track_name: "CONF_MAIN" }]
    }),
    null
  );
});

test("executeCommandPlan inserts created tracks sequentially below the selection", async () => {
  const createRequests = [];
  let getTrackListCall = 0;
  const client = {
    async send(command, body) {
      if (command === "GetTrackList") {
        getTrackListCall += 1;
        return getTrackListCall === 1
          ? {
              header: { status: "TStatus_Completed" },
              body: { track_list: [{ name: "EDIT_DEMO", index: 5 }] }
            }
          : {
              header: { status: "TStatus_Completed" },
              body: { track_list: [{ name: "EDIT_DEMO", index: 5 }] }
            };
      }
      if (command === "CreateNewTracks") {
        createRequests.push(body);
      }
      return { header: { status: "TStatus_Completed" }, body: {} };
    }
  };

  await executeCommandPlan({
    imports: [],
    createTracks: [
      { track_name: "CONF_MAIN", number_of_tracks: 1, channel_count: 1 },
      { track_name: "CONF_ROOM", number_of_tracks: 1, channel_count: 2 }
    ],
    clipGroups: [],
    fadeGroups: [],
    issues: []
  }, client);

  assert.deepEqual(createRequests, [
    {
      track_name: "CONF_MAIN",
      number_of_tracks: 1,
      insertion_point_position: "TIPoint_After",
      insertion_point_track_name: "EDIT_DEMO"
    },
    {
      track_name: "CONF_ROOM",
      number_of_tracks: 1,
      insertion_point_position: "TIPoint_After",
      insertion_point_track_name: "CONF_MAIN"
    }
  ]);
});

test("executeCommandPlan inserts created tracks at the session bottom without a selection", async () => {
  const createRequests = [];
  const client = {
    async send(command, body) {
      if (command === "GetTrackList") {
        return {
          header: { status: "TStatus_Completed" },
          body: { track_list: [] }
        };
      }
      if (command === "CreateNewTracks") {
        createRequests.push(body);
      }
      return { header: { status: "TStatus_Completed" }, body: {} };
    }
  };

  await executeCommandPlan({
    imports: [],
    createTracks: [
      { track_name: "CONF_MAIN", number_of_tracks: 1, channel_count: 1 },
      { track_name: "CONF_ROOM", number_of_tracks: 1, channel_count: 2 }
    ],
    clipGroups: [],
    fadeGroups: [],
    issues: []
  }, client);

  assert.deepEqual(createRequests, [
    {
      track_name: "CONF_MAIN",
      number_of_tracks: 1,
      insertion_point_position: "TIPoint_Last"
    },
    {
      track_name: "CONF_ROOM",
      number_of_tracks: 1,
      insertion_point_position: "TIPoint_Last"
    }
  ]);
});

test('failed fade track selection stops before changing timeline or creating fades', async () => {
  const calls=[];
  const client={ async send(command) {
    calls.push(command);
    return command === 'SelectTracksByName'
      ? {header:{status:'TStatus_Failed'},errors:{errors:[{command_error_message:'Track missing'}]}}
      : {header:{status:'TStatus_Completed'},body:{track_list:[]}};
  }};
  await assert.rejects(executeCommandPlan({imports:[],createTracks:[],clipGroups:[],issues:[],fadeGroups:[{
    destinationTrack:'OUT',timelineStartSamples:900,timelineEndSamples:1000,
    selectTracksByNameRequest:{track_names:['OUT']},setTimelineSelectionRequest:{},createFadesBasedOnPresetRequest:{}
  }]},client), /SelectTracksByName failed on OUT/);
  assert.equal(calls.includes('SetTimelineSelection'),false);
  assert.equal(calls.includes('CreateFadesBasedOnPreset'),false);
});
