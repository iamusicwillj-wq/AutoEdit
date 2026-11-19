import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTransportRequest,
  normalizeTransportResponse
} from "../src/ptslClient.js";

test("builds snake_case transport envelope for source proto", () => {
  const request = buildTransportRequest({
    command: 70,
    sessionId: "",
    body: { company_name: "Auto Edit", application_name: "AutoEdit" },
    descriptorFields: false,
    taskId: "task-1"
  });

  assert.equal(request.header.task_id, "task-1");
  assert.equal(request.header.version_minor, 10);
  assert.equal(request.request_body_json, JSON.stringify({
    company_name: "Auto Edit",
    application_name: "AutoEdit"
  }));
});

test("builds camelCase transport envelope for runtime descriptor", () => {
  const request = buildTransportRequest({
    command: 70,
    sessionId: "",
    body: { company_name: "Auto Edit", application_name: "AutoEdit" },
    descriptorFields: true,
    taskId: "task-2"
  });

  assert.equal(request.header.taskId, "task-2");
  assert.equal(request.header.versionMinor, 10);
  assert.equal(request.requestBodyJson, JSON.stringify({
    company_name: "Auto Edit",
    application_name: "AutoEdit"
  }));
  assert.equal(request.request_body_json, undefined);
});

test("normalizes descriptor response envelope before parsing body", () => {
  const response = normalizeTransportResponse({
    header: {
      taskId: "task-3",
      command: "CId_RegisterConnection",
      status: "TStatus_Completed",
      progress: 100,
      version: 2026,
      versionMinor: 4,
      versionRevision: 0,
      versionedResponseHeaderJson: ""
    },
    responseBodyJson: "{\"session_id\":\"session-1\"}",
    responseErrorJson: ""
  }, true);

  assert.equal(response.header.task_id, "task-3");
  assert.equal(response.header.version_minor, 4);
  assert.equal(response.response_body_json, "{\"session_id\":\"session-1\"}");
});
