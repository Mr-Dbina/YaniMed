import { create } from "zustand";

interface SidebarState {
  isCollapsed: boolean;
  isPreview: boolean;
  toggle: () => void;
  setPreview: (value: boolean) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  isCollapsed: false,
  isPreview: false,
  toggle: () =>
    set((state) => ({ isCollapsed: !state.isCollapsed, isPreview: false })),
  setPreview: (value) => set({ isPreview: value }),
}));
