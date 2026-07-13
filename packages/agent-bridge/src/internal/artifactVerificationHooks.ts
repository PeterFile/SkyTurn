import type { WindowsArtifactVerifierDependencies } from "./windowsExpectedArtifactVerifier.js";

export interface ArtifactVerificationHooks {
  afterWorktreeOpen?: (fd: number) => Promise<void> | void;
  beforeHelperStart?: () => Promise<void> | void;
  afterParentOpen?: () => Promise<void> | void;
  afterArtifactOpen?: (helperPid: number) => Promise<void> | void;
  afterOpen?: (helperPid: number) => Promise<void> | void;
  helperPath?: string;
  helperTimeoutMs?: number;
  platform?: NodeJS.Platform;
  windowsVerifierDependencies?: WindowsArtifactVerifierDependencies;
}

export const artifactVerificationHooksCarrier = Symbol("artifact-verification-hooks");

export interface ArtifactVerificationHookCarrier {
  [artifactVerificationHooksCarrier]?: ArtifactVerificationHooks;
}

export function artifactVerificationHooksFrom(options: object): ArtifactVerificationHooks | undefined {
  return (options as ArtifactVerificationHookCarrier)[artifactVerificationHooksCarrier];
}

export function withArtifactVerificationHooks<T extends object>(
  options: T,
  hooks: ArtifactVerificationHooks | undefined,
): T & ArtifactVerificationHookCarrier {
  return hooks === undefined
    ? options
    : Object.assign(options, { [artifactVerificationHooksCarrier]: hooks });
}
