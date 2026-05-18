import { create } from "zustand";
import { meExtraApi, type MyPermissions } from "@/lib/api";

// Effective permissions cache used by Layout to hide nav items a user can't
// reach (scripts, etc.) and by guards on a few mutating-action buttons.
// The backend is the source of truth — UI gating is just a courtesy. Stale
// cache is refreshed on every login and on demand via reload().

interface PermissionsState {
  perms: MyPermissions | null;
  loaded: boolean;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  has: (op: string) => boolean;
  reset: () => void;
}

const EMPTY: MyPermissions = {
  is_admin: false,
  operations: [],
  all_operations: [],
  all_pipelines: false,
  pipeline_ids: [],
  all_scripts: false,
  script_ids: [],
};

async function fetchPerms(): Promise<MyPermissions> {
  try {
    const r = await meExtraApi.permissions();
    return r.data;
  } catch {
    return EMPTY;
  }
}

export const usePermissionsStore = create<PermissionsState>((set, get) => ({
  perms: null,
  loaded: false,
  async load() {
    if (get().loaded) return;
    const p = await fetchPerms();
    set({ perms: p, loaded: true });
  },
  async reload() {
    const p = await fetchPerms();
    set({ perms: p, loaded: true });
  },
  has(op: string) {
    const p = get().perms;
    if (!p) return false;
    if (p.is_admin) return true;
    return p.operations.includes(op);
  },
  reset() {
    set({ perms: null, loaded: false });
  },
}));
