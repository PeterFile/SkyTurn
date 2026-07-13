import {
  createCodexCliAdapter,
  createHermesCliAdapter,
  type CodexCliAdapterOptions,
  type HermesCliAdapterOptions,
} from "../index.js";
import {
  withArtifactVerificationHooks,
  type ArtifactVerificationHooks,
} from "./artifactVerificationHooks.js";

export type TestCodexCliAdapterOptions = CodexCliAdapterOptions & {
  artifactVerificationHooks?: ArtifactVerificationHooks;
};

export type TestHermesCliAdapterOptions = HermesCliAdapterOptions & {
  artifactVerificationHooks?: ArtifactVerificationHooks;
};

export function createTestCodexCliAdapter(options: TestCodexCliAdapterOptions = {}) {
  const { artifactVerificationHooks, ...publicOptions } = options;
  return createCodexCliAdapter(withArtifactVerificationHooks(publicOptions, artifactVerificationHooks));
}

export function createTestHermesCliAdapter(options: TestHermesCliAdapterOptions = {}) {
  const { artifactVerificationHooks, ...publicOptions } = options;
  return createHermesCliAdapter(withArtifactVerificationHooks(publicOptions, artifactVerificationHooks));
}
