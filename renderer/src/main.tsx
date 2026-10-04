import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./effects-final.css";

// Product effects use the same full-motion policy in the installed app and demo.
// Windows' animation setting must not silently hide particles or stop the approved
// surfaces. Keep the original CSS intact; only switch its reduced-motion branches.
// Explicit reduced-motion review remains available in the fictional demo only.
const motionQuery = new URLSearchParams(window.location.search);
const reducedEffectReview = motionQuery.get("demo") === "1" && motionQuery.get("motion") === "reduce";
const applyEffectMotion = (rules: CSSRuleList) => {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion")) {
      rule.media.mediaText = reducedEffectReview ? "all" : "not all";
    } else if ("cssRules" in rule) {
      applyEffectMotion((rule as CSSGroupingRule).cssRules);
    }
  }
};
for (const sheet of Array.from(document.styleSheets)) {
  try { applyEffectMotion(sheet.cssRules); }
  catch (error) {
    if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
