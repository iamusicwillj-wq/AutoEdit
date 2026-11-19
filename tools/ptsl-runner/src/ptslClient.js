import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import {
  commandIdsPath,
  descriptorPath,
  localSdkProtoPath,
  protoPath,
  sessionFilePath
} from "./paths.js";

const PTSL_VERSION_MAJOR = 2025;
const PTSL_VERSION_MINOR = 10;
const PTSL_VERSION_REVISION = 0;
let cachedCommandIds;

function resolveProtoPath() {
  if (fs.existsSync(localSdkProtoPath)) {
    return localSdkProtoPath;
  }
  if (fs.existsSync(protoPath)) {
    return protoPath;
  }
  throw new Error(`Missing Avid Pro Tools Scripting SDK (2025.10). Place its PTSL.proto at ${localSdkProtoPath}.`);
}

function loadCommandIds(sourcePath) {
  if (sourcePath === null) {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(commandIdsPath, "utf8"))));
  }
  const proto = fs.readFileSync(sourcePath, "utf8");
  const ids = new Map();
  const commandRegex = /^\s*(CId_)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(\d+)\s*;/gm;
  let match;
  while ((match = commandRegex.exec(proto))) {
    const fullName = `${match[1] ?? ""}${match[2]}`;
    const baseName = match[2];
    const value = Number(match[3]);
    ids.set(fullName, value);
    if (match[1] === "CId_") {
      ids.set(baseName, value);
    }
  }
  return ids;
}

function parseJsonObject(value, label) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error.message}`);
  }
}

function bodyFromResponse(response) {
  if (!response?.response_body_json) {
    return {};
  }
  try {
    return JSON.parse(response.response_body_json);
  } catch {
    return { raw: response.response_body_json };
  }
}

export function buildTransportRequest({
  command,
  sessionId,
  body,
  versionedHeader,
  descriptorFields = false,
  taskId = crypto.randomUUID()
}) {
  const header = descriptorFields
    ? {
        taskId,
        command,
        version: PTSL_VERSION_MAJOR,
        versionMinor: PTSL_VERSION_MINOR,
        versionRevision: PTSL_VERSION_REVISION,
        sessionId,
        versionedRequestHeaderJson: versionedHeader ? JSON.stringify(versionedHeader) : ""
      }
    : {
        task_id: taskId,
        command,
        version: PTSL_VERSION_MAJOR,
        version_minor: PTSL_VERSION_MINOR,
        version_revision: PTSL_VERSION_REVISION,
        session_id: sessionId,
        versioned_request_header_json: versionedHeader ? JSON.stringify(versionedHeader) : ""
      };

  return descriptorFields
    ? { header, requestBodyJson: JSON.stringify(body ?? {}) }
    : { header, request_body_json: JSON.stringify(body ?? {}) };
}

export function normalizeTransportResponse(response, descriptorFields = false) {
  if (!descriptorFields) {
    return response;
  }

  const header = response?.header ?? {};
  return {
    header: {
      task_id: header.taskId ?? "",
      command: header.command,
      status: header.status,
      progress: header.progress,
      version: header.version,
      version_minor: header.versionMinor ?? 0,
      version_revision: header.versionRevision ?? 0,
      versioned_response_header_json: header.versionedResponseHeaderJson ?? ""
    },
    response_body_json: response?.responseBodyJson ?? "",
    response_error_json: response?.responseErrorJson ?? ""
  };
}

function errorsFromResponse(response) {
  if (!response?.response_error_json) {
    return {};
  }
  try {
    return JSON.parse(response.response_error_json);
  } catch {
    return { raw: response.response_error_json };
  }
}

export function loadSavedSessionId() {
  if (!fs.existsSync(sessionFilePath)) {
    return "";
  }
  try {
    return JSON.parse(fs.readFileSync(sessionFilePath, "utf8")).sessionId ?? "";
  } catch {
    return "";
  }
}

export function saveSessionId(sessionId) {
  fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true });
  fs.writeFileSync(
    sessionFilePath,
    JSON.stringify({ sessionId, savedAt: new Date().toISOString() }, null, 2)
  );
}

export class PtslClient {
  constructor({ address = "localhost:31416", sessionId = "" } = {}) {
    this.descriptorFields = fs.existsSync(descriptorPath) && fs.existsSync(commandIdsPath);
    const sourcePath = this.descriptorFields ? null : resolveProtoPath();
    this.commandIds = cachedCommandIds ??= loadCommandIds(sourcePath);
    const loaderOptions = {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    };
    const definition = this.descriptorFields
      ? protoLoader.loadFileDescriptorSetFromBuffer(fs.readFileSync(descriptorPath), loaderOptions)
      : protoLoader.loadSync(sourcePath, loaderOptions);
    const loaded = grpc.loadPackageDefinition(definition);
    this.client = new loaded.ptsl.PTSL(address, grpc.credentials.createInsecure());
    this.sessionId = sessionId;
  }

  close() {
    this.client.close();
  }

  commandId(commandName) {
    const normalized = commandName.startsWith("CId_") ? commandName : `CId_${commandName}`;
    const id = this.commandIds.get(normalized) ?? this.commandIds.get(commandName);
    if (id === undefined) {
      throw new Error(`Unknown PTSL command: ${commandName}`);
    }
    return id;
  }

  async send(commandName, body = {}, options = {}) {
    const command = this.commandId(commandName);
    const request = buildTransportRequest({
      command,
      sessionId: options.sessionId ?? this.sessionId ?? "",
      body,
      versionedHeader: options.versionedHeader,
      descriptorFields: this.descriptorFields
    });

    const method = this.client.SendGrpcRequest
      ? "SendGrpcRequest"
      : this.client.sendGrpcRequest
        ? "sendGrpcRequest"
        : null;

    if (!method) {
      throw new Error("PTSL service did not expose SendGrpcRequest");
    }

    const response = await new Promise((resolve, reject) => {
      this.client[method](request, (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });

    const normalizedResponse = normalizeTransportResponse(response, this.descriptorFields);
    return {
      commandName,
      header: normalizedResponse.header ?? {},
      body: bodyFromResponse(normalizedResponse),
      errors: errorsFromResponse(normalizedResponse),
      raw: normalizedResponse
    };
  }

  async register({
    companyName = "Auto Edit",
    applicationName = "PTSL Music Conformer Phase0"
  } = {}) {
    const response = await this.send("RegisterConnection", {
      company_name: companyName,
      application_name: applicationName
    }, { sessionId: "" });
    const sessionId = response.body.session_id;
    if (!sessionId) {
      throw new Error(`RegisterConnection did not return session_id: ${JSON.stringify(response)}`);
    }
    this.sessionId = sessionId;
    saveSessionId(sessionId);
    return response;
  }
}

export function parseCliJson(value, label) {
  return parseJsonObject(value, label);
}

export function isFailure(response) {
  const status = response?.header?.status;
  return status === "TStatus_Failed" || status === "Failed" || status === 4;
}
