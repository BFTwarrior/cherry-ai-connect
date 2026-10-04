import { useSyncExternalStore } from "react";

// Page-local simulation shared by both cards. It survives navigation between
// Settings and Cloud Sync, but a reload resets it. No IPC, fetch or storage.
type DemoUpdate = { active: boolean; completed: boolean; progress: UpdateProgress | null };
let snapshot: DemoUpdate = { active: false, completed: false, progress: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
const total = 99928574;

function emit(next: DemoUpdate) {
  snapshot = next;
  for (const listener of listeners) listener();
}
function stopTimer() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}
function advance(stage: UpdateProgress["stage"], percent = 0) {
  emit({ active: true, completed: false, progress: {
    sequence: ++sequence, stage, percent, total,
    received: stage === "downloading" ? Math.round(total * percent / 100) : total,
    canCancel: stage !== "installing", at: new Date().toISOString(),
  } });
  timer = setTimeout(() => {
    timer = undefined;
    if (stage === "downloading" && percent < 100) advance(stage, Math.min(100, percent + 4));
    else if (stage === "downloading") advance("syncing", 100);
    else if (stage === "syncing") advance("backing-up", 100);
    else if (stage === "backing-up") advance("installing", 100);
    else emit({ active: false, completed: true, progress: null });
  }, stage === "downloading" ? 1200 : 4000);
}

export function startDemoUpdate() {
  if (snapshot.active) return;
  stopTimer();
  advance("downloading");
}
export function cancelDemoUpdate() {
  if (!snapshot.active || !snapshot.progress?.canCancel) return;
  stopTimer();
  emit({ active: false, completed: false, progress: null });
}
export function resetDemoUpdate() {
  if (snapshot.active) return;
  stopTimer();
  emit({ active: false, completed: false, progress: null });
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => snapshot;
export function useDemoUpdate() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
