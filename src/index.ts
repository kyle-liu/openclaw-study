#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
// ============================================================================
// index.ts
//
// 这是整个项目的顶层入口文件，同时承担两种角色：
//
// 1. CLI 启动入口
//    - 当这个文件作为主程序执行时，会初始化环境并启动命令行程序
//
// 2. 顶层公共导出入口
//    - 当其他模块把这个项目当成库来使用时，可以从这里拿到最常用的公开 API
//
// 所以它的定位比 `channel-web.ts`、`channels/web/index.ts` 更高一层：
// - `channel-web.ts`：Web 通道子系统门面
// - `channels/web/index.ts`：channels 命名空间下的 Web 索引
// - `index.ts`：整个项目最顶层的总出口
//
// 阅读这个文件时，重点看两部分：
// - 顶部：启动前环境初始化
// - 中间：`export { ... }` 导出哪些项目级公开 API
// ============================================================================
import { getReplyFromConfig } from "./auto-reply/reply.js";
import { applyTemplate } from "./auto-reply/templating.js";
import { monitorWebChannel } from "./channel-web.js";
import { createDefaultDeps } from "./cli/deps.js";
import { promptYesNo } from "./cli/prompt.js";
import { waitForever } from "./cli/wait.js";
import { loadConfig } from "./config/config.js";
import {
  deriveSessionKey,
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  saveSessionStore,
} from "./config/sessions.js";
import { ensureBinary } from "./infra/binaries.js";
import { loadDotEnv } from "./infra/dotenv.js";
import { normalizeEnv } from "./infra/env.js";
import { formatUncaughtError } from "./infra/errors.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawCliOnPath } from "./infra/path-env.js";
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
import { assertSupportedRuntime } from "./infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "./infra/unhandled-rejections.js";
import { enableConsoleCapture } from "./logging.js";
import { runCommandWithTimeout, runExec } from "./process/exec.js";
import { assertWebChannel, normalizeE164, toWhatsappJid } from "./utils.js";

loadDotEnv({ quiet: true });
normalizeEnv();
ensureOpenClawCliOnPath();

// Capture all console output into structured logs while keeping stdout/stderr behavior.
enableConsoleCapture();

// Enforce the minimum supported runtime before doing any work.
assertSupportedRuntime();

import { buildProgram } from "./cli/program.js";

const program = buildProgram();

// 这里统一导出项目对外最常用的公共 API。
// 例如：
// - `getReplyFromConfig`：自动回复核心入口之一
// - `monitorWebChannel`：Web / WhatsApp 监听入口
//
// 这说明 `monitorWebChannel` 不只是内部函数，
// 还被提升成了整个项目顶层的公开能力。
export {
  assertWebChannel,
  applyTemplate,
  createDefaultDeps,
  deriveSessionKey,
  describePortOwner,
  ensureBinary,
  ensurePortAvailable,
  getReplyFromConfig,
  handlePortError,
  loadConfig,
  loadSessionStore,
  monitorWebChannel,
  normalizeE164,
  PortInUseError,
  promptYesNo,
  resolveSessionKey,
  resolveStorePath,
  runCommandWithTimeout,
  runExec,
  saveSessionStore,
  toWhatsappJid,
  waitForever,
};

const isMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
});

if (isMain) {
  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  void program.parseAsync(process.argv).catch((err) => {
    console.error("[openclaw] CLI failed:", formatUncaughtError(err));
    process.exit(1);
  });
}
