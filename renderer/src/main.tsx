import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./effects-final.css";

// Full-motion review explicitly opts the fictional demo out of system motion reduction.
// The installed app continues to use the user's system preference.
const previewQuery = new URLSearchParams(window.location.search);
if (previewQuery.get("demo") === "1" && previewQuery.get("motion") === "full") {
  const enablePreviewMotion = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion")) {
        rule.media.mediaText = "not all";
      } else if ("cssRules" in rule) {
        enablePreviewMotion((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { enablePreviewMotion(sheet.cssRules); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
    }
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
