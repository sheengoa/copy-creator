import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ResourceGroup } from "../types";

function getResourceGroupErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "资源分组操作失败，请重试";
}

interface ResourceGroupState {
  groups: ResourceGroup[];
  selectedGroupId: string | null;
  initialized: boolean;
  error: string | null;
  init: () => void;
  loadGroups: () => Promise<void>;
  clearError: () => void;
  setSelectedGroup: (id: string) => void;
  createGroup: (name: string) => Promise<ResourceGroup | null>;
  updateGroup: (id: string, name: string) => Promise<boolean>;
  deleteGroup: (id: string) => Promise<boolean>;
  reorderGroups: (ids: string[]) => Promise<void>;
}

export const useResourceGroupStore = create<ResourceGroupState>((set, get) => ({
  groups: [],
  selectedGroupId: null,
  initialized: false,
  error: null,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    listen("resource-groups-changed", () => {
      void get().loadGroups();
    });
    void get().loadGroups();
  },

  loadGroups: async () => {
    try {
      const groups = await invoke<ResourceGroup[]>("get_resource_groups");
      const selectedGroupId = get().selectedGroupId;
      set({
        groups,
        selectedGroupId:
          groups.some((group) => group.id === selectedGroupId)
            ? selectedGroupId
            : groups[0]?.id ?? null,
        error: null,
      });
    } catch (error) {
      console.error("Failed to load resource groups:", error);
      set({ error: getResourceGroupErrorMessage(error) });
    }
  },

  clearError: () => set({ error: null }),

  setSelectedGroup: (id) => set({ selectedGroupId: id }),

  createGroup: async (name) => {
    set({ error: null });
    try {
      const group = await invoke<ResourceGroup>("create_resource_group", { name });
      set((state) => ({
        groups: [...state.groups, group],
        selectedGroupId: group.id,
        error: null,
      }));
      return group;
    } catch (error) {
      console.error("Failed to create resource group:", error);
      set({ error: getResourceGroupErrorMessage(error) });
      return null;
    }
  },

  updateGroup: async (id, name) => {
    set({ error: null });
    try {
      await invoke("update_resource_group", { id, name });
      set((state) => ({
        groups: state.groups.map((group) =>
          group.id === id ? { ...group, name } : group,
        ),
        error: null,
      }));
      return true;
    } catch (error) {
      console.error("Failed to update resource group:", error);
      set({ error: getResourceGroupErrorMessage(error) });
      return false;
    }
  },

  deleteGroup: async (id) => {
    set({ error: null });
    try {
      await invoke("delete_resource_group", { id });
      set((state) => {
        const groups = state.groups.filter((group) => group.id !== id);
        return {
          groups,
          selectedGroupId:
            state.selectedGroupId === id ? groups[0]?.id ?? null : state.selectedGroupId,
          error: null,
        };
      });
      return true;
    } catch (error) {
      console.error("Failed to delete resource group:", error);
      set({ error: getResourceGroupErrorMessage(error) });
      return false;
    }
  },

  reorderGroups: async (ids) => {
    const idOrder = new Map(ids.map((id, index) => [id, index]));
    set((state) => ({
      groups: [...state.groups].sort(
        (a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity),
      ),
    }));
    try {
      await invoke("reorder_resource_groups", { ids });
    } catch (error) {
      console.error("Failed to reorder resource groups:", error);
    }
  },
}));
