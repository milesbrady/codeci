import { create } from "zustand";

export type NotificationKind = "success" | "failed" | "info";

export interface NotificationItem {
  id: string;
  runId?: number;
  pipelineId?: string;
  pipelineName?: string;
  kind: NotificationKind;
  title: string;
  message: string;
  createdAt: number;
  read: boolean;
}

export type NotifyPermission = NotificationPermission | "unsupported";

interface NotificationsState {
  items: NotificationItem[];
  permission: NotifyPermission;
  add: (n: Omit<NotificationItem, "id" | "createdAt" | "read">) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
  requestPermission: () => Promise<NotifyPermission>;
  refreshPermission: () => void;
  testBrowserNotification: () => { ok: boolean; reason?: string };
}

const MAX_ITEMS = 50;
const STORAGE_KEY = "notifications.v1";

function detectPermission(): NotifyPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function loadFromSession(): NotificationItem[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function saveToSession(items: NotificationItem[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // sessionStorage may be unavailable / quota exceeded — fail silent
  }
}

function fireBrowserNotification(item: NotificationItem): { ok: boolean; reason?: string } {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ok: false, reason: "Notification API unavailable" };
  }
  if (Notification.permission !== "granted") {
    return { ok: false, reason: `permission=${Notification.permission}` };
  }
  try {
    const n = new Notification(item.title, {
      body: item.message,
      // `tag` collapses duplicate notifications; using runId is fine for completions
      // but for the manual test we want it to always show, so callers can override via item.id.
      tag: `run-${item.runId ?? item.id}`,
      icon: "/favicon.ico",
      // Firefox honors this on macOS — desktop alert stays until clicked rather than
      // sliding away after ~4s, which is what most users expect for "your job finished".
      requireInteraction: item.kind !== "info",
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      if (item.runId != null) {
        window.location.href = `/runs/${item.runId}`;
      }
      n.close();
    };
    n.onerror = (ev) => {
      // Surface failures so the user can debug OS-level Do Not Disturb / Focus modes.
      // eslint-disable-next-line no-console
      console.warn("[notifications] desktop notification reported error:", ev);
    };
    return { ok: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[notifications] failed to construct desktop Notification:", e);
    return { ok: false, reason: e instanceof Error ? e.message : "construct failed" };
  }
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: loadFromSession(),
  permission: detectPermission(),

  add: (n) => {
    const item: NotificationItem = {
      ...n,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      read: false,
    };
    const next = [item, ...get().items].slice(0, MAX_ITEMS);
    saveToSession(next);
    set({ items: next });
    fireBrowserNotification(item);
  },

  markRead: (id) => {
    const next = get().items.map((it) => (it.id === id ? { ...it, read: true } : it));
    saveToSession(next);
    set({ items: next });
  },

  markAllRead: () => {
    const next = get().items.map((it) => ({ ...it, read: true }));
    saveToSession(next);
    set({ items: next });
  },

  remove: (id) => {
    const next = get().items.filter((it) => it.id !== id);
    saveToSession(next);
    set({ items: next });
  },

  clear: () => {
    saveToSession([]);
    set({ items: [] });
  },

  requestPermission: async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      set({ permission: "unsupported" });
      return "unsupported";
    }
    let result: NotificationPermission = Notification.permission;
    if (result === "default") {
      try {
        result = await Notification.requestPermission();
      } catch {
        result = Notification.permission;
      }
    }
    set({ permission: result });
    return result;
  },

  refreshPermission: () => set({ permission: detectPermission() }),

  testBrowserNotification: () => {
    const result = fireBrowserNotification({
      id: `test-${Date.now()}`,
      kind: "info",
      title: "Notifications are working",
      message: "If you see this, desktop notifications will fire when a pipeline finishes.",
      createdAt: Date.now(),
      read: false,
    });
    return result;
  },
}));
