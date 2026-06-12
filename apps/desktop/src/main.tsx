import React from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import { SkyTurnApp } from "@skyturn/ui-canvas";
import "@skyturn/ui-canvas/styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SkyTurnApp />
  </React.StrictMode>,
);
