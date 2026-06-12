import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("devflow", {
  openProject: () => ipcRenderer.invoke("project:open"),
  initializeProjectMemory: (rootPath: string) => ipcRenderer.invoke("project:initDevflow", rootPath),
  loadWorkspace: () => ipcRenderer.invoke("workspace:load"),
  saveWorkspace: (state: unknown) => ipcRenderer.invoke("workspace:save", state),
  openEditor: (editor: string, worktreePath: string) =>
    ipcRenderer.invoke("editor:openWorktree", editor, worktreePath),
});
