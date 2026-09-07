import { SettingsRuntimeError } from "./settingsRuntime";

export const SETTINGS_IPC_CHANNELS = {
  get: "settings:get",
  save: "settings:save",
} as const;

export type SettingsIpcErrorCode =
  | "INVALID_INPUT"
  | "PROJECT_NOT_REGISTERED"
  | "SETTINGS_STORAGE_INVALID"
  | "SETTINGS_CAPACITY_EXCEEDED"
  | "SETTINGS_IO";

export function normalizeSettingsIpcError(error: unknown): Error {
  if (error instanceof SettingsRuntimeError) {
    const code = error.code === "INVALID_PERSISTED_SETTINGS" ? "SETTINGS_STORAGE_INVALID" : error.code;
    return explicitError(code, error.message);
  }
  if (error instanceof Error && error.message === "Project root is not open in SkyTurn.") {
    return explicitError("PROJECT_NOT_REGISTERED", error.message);
  }
  return explicitError("SETTINGS_IO", "Settings operation failed.");
}

function explicitError(code: SettingsIpcErrorCode, message: string): Error {
  return new Error(`[${code}] ${message}`);
}
