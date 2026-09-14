"use strict";

/**
 * Durable session logging for AIPickVault Desktop.
 * Design Webber / agents: Read
 *   %APPDATA%\AIPickVault-Desktop\logs\session-YYYYMMDD.log
 */

const fs = require("fs");
const path = require("path");

const MAX_FILE_BYTES = 5 * 1024 * 1024; // ~5 MB soft cap per daily file
const PROMPT_TRUNCATE = 2000;
const REPLY_TRUNCATE = 8000;

function logsRoot() {
  const appData =
    process.env.APPDATA ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    ".";
  return path.join(appData, "AIPickVault-Desktop", "logs");
}

function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function logFilePath() {
  return path.join(logsRoot(), `session-${todayStamp()}.log`);
}

function ensureLogDir() {
  const dir = logsRoot();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return dir;
}

function truncate(text, max) {
  const s = String(text == null ? "" : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[+${s.length - max} chars]`;
}

function stamp() {
  return new Date().toISOString();
}

function maybeRotate(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.size < MAX_FILE_BYTES) return filePath;
    const rotated = filePath.replace(/\.log$/, `.overflow-${Date.now()}.log`);
    fs.renameSync(filePath, rotated);
  } catch (_) {
    /* first write or race — fine */
  }
  return filePath;
}

function writeLine(level, tag, detail) {
  ensureLogDir();
  let file = logFilePath();
  file = maybeRotate(file);
  const line =
    `[${stamp()}] [${level}] ${tag}` +
    (detail != null && detail !== "" ? ` ${detail}` : "") +
    "\n";
  try {
    fs.appendFileSync(file, line, "utf8");
  } catch (err) {
    console.error("SESSION_LOG_WRITE_FAILED:", err && err.message ? err.message : err);
  }
  return file;
}

function info(tag, detail) {
  const d = detail == null ? "" : String(detail);
  console.log(`[session] ${tag}`, d.length > 200 ? d.slice(0, 200) + "…" : d);
  return writeLine("INFO", tag, d);
}

function error(tag, errOrDetail) {
  let detail = "";
  if (errOrDetail && typeof errOrDetail === "object") {
    const msg = errOrDetail.message || String(errOrDetail);
    const stack = errOrDetail.stack || "";
    detail = stack || msg;
  } else {
    detail = String(errOrDetail == null ? "" : errOrDetail);
  }
  console.error(`[session] ${tag}`, detail);
  return writeLine("ERROR", tag, detail);
}

function prompt(text) {
  return info("PROMPT", truncate(text, PROMPT_TRUNCATE));
}

function route(routeObj) {
  return info("ROUTE", JSON.stringify(routeObj || {}));
}

function toolStep(label, ok, detail) {
  return info(
    "TOOL",
    `${ok ? "OK" : "FAIL"} ${label}` + (detail ? ` — ${truncate(detail, 400)}` : "")
  );
}

function synthesize(phase) {
  return info("SYNTHESIZE", phase);
}

function reply(text) {
  return info("REPLY", truncate(text, REPLY_TRUNCATE));
}

function getLogPath() {
  ensureLogDir();
  return logFilePath();
}

module.exports = {
  logsRoot,
  logFilePath,
  getLogPath,
  info,
  error,
  prompt,
  route,
  toolStep,
  synthesize,
  reply,
  truncate
};
