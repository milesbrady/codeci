import { create } from "zustand";
import { configApi } from "@/lib/api";

interface AppConfigState {
  name: string;
  version: string;
  terminalEnabled: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setName: (name: string) => void;
}

const DEFAULT_NAME = "Codeci";

export const useAppConfigStore = create<AppConfigState>((set, get) => ({
  name: DEFAULT_NAME,
  version: "",
  terminalEnabled: true,
  loaded: false,
  load: async () => {
    try {
      const res = await configApi.getApp();
      set({
        name: res.data.name || DEFAULT_NAME,
        version: res.data.version || "",
        terminalEnabled: res.data.terminal_enabled !== false,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },
  setName: (name: string) => {
    if (name && name !== get().name) set({ name });
  },
}));
