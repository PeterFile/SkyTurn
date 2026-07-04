import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);

test("New Session UI acceptance script drives the real renderer input and Create button", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /textarea\[aria-label="New task goal"\]/);
  assert.match(source, /button\[aria-label="Create"\]/);
  assert.match(source, /fillTextareaAndClickCreate/);
  assert.match(source, /launchElectronAcceptanceApp/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /--user-data-dir=/);
  assert.doesNotMatch(source, /openProject\(/);
  assert.doesNotMatch(source, /createWorkflowSession\(/);
});

test("New Session UI acceptance pre-seeds isolated workspace state for one real project", async () => {
  const { makeImportedProject, preseedWorkspaceState } = await import("./newSessionUiAcceptance.mjs");
  const userData = await mkdtemp(join(tmpdir(), "skyturn-new-session-user-data-test-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-new-session-project-test-"));

  try {
    const project = makeImportedProject(projectRoot);
    const workspacePath = await preseedWorkspaceState(userData, project);
    const workspace = JSON.parse(await readFile(workspacePath, "utf8"));

    assert.equal(workspace.projects.length, 1);
    assert.deepEqual(workspace.projects[0], project);
    assert.equal(workspace.activeProjectId, project.id);
    assert.equal(workspace.activeSessionId, null);
    assert.deepEqual(workspace.sessions, []);
    assert.deepEqual(workspace.runEvidence, {});
  } finally {
    await rm(userData, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("New Session UI acceptance fail-fast readiness runs before Electron launch", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const preflightIndex = source.indexOf("const readinessPreflight = await demoReadinessPreflight(bridge)");
  const failFastIndex = source.indexOf("if (readinessPreflight.failFast)");
  const launchIndex = source.indexOf("await launchElectronAcceptanceApp");

  assert.ok(preflightIndex >= 0, "script must discover Hermes/Codex readiness.");
  assert.ok(failFastIndex > preflightIndex, "script must evaluate readiness after discovery.");
  assert.ok(launchIndex > failFastIndex, "script must not launch Electron before readiness passes.");
});

test("New Session UI acceptance keeps the verification script as fixed evidence", async () => {
  const { fileSha256 } = await import("./newSessionUiAcceptance.mjs");
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-new-session-fixed-verify-test-"));
  const verifyScript = join(projectRoot, "verify.mjs");

  try {
    await writeFile(verifyScript, "console.log('fixed contract');\n");
    const firstHash = await fileSha256(verifyScript);
    await writeFile(verifyScript, "console.log('tampered contract');\n");
    const secondHash = await fileSha256(verifyScript);

    assert.notEqual(firstHash, secondHash);
    assert.match(source, /Do not modify scripts\/verify\.mjs/);
    assert.match(source, /scripts\/capture-screenshot\.mjs/);
    assert.match(source, /Only src\/App\.jsx and src\/App\.css may be changed or committed/);
    assert.match(source, /verification-script-changed/);
    assert.match(source, /unexpected-delivery-files/);
    assert.match(source, /verificationScript: verification\.verificationScript/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("New Session UI acceptance reports and cleans Electron launch failures", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /ELECTRON_LAUNCH_FAILED/);
  assert.match(source, /RENDERER_AUTOMATION_FAILED/);
  assert.match(source, /Promise\.allSettled\(\[electron\.close\(\), vite\.close\(\)\]\)/);
});

test("New Session UI acceptance is exposed as an explicit desktop package script", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

  assert.equal(packageJson.scripts["acceptance:new-session-ui"], "node scripts/newSessionUiAcceptance.mjs");
});
