import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

export async function resolveCliExecutable(
  executablePath: string | undefined,
  candidates: string[],
  pathValue: string,
): Promise<string | null> {
  if (!executablePath) return findExecutable(candidates, pathValue);
  if (!isPathLikeCommand(executablePath)) return findExecutable([executablePath], pathValue);
  const absoluteExecutablePath = resolve(executablePath);
  try {
    await access(absoluteExecutablePath, fsConstants.X_OK);
    return absoluteExecutablePath;
  } catch {
    return null;
  }
}

function isPathLikeCommand(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function findExecutable(commands: string[], pathValue: string): Promise<string | null> {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const command of commands) {
      const candidate = resolve(directory, command);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}
