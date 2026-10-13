import { useSyncExternalStore } from "react";

const query = window.matchMedia("(max-width: 1023px)");
const subscribe = (listener: () => void) => {
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, () => query.matches);
}
