import React from "react";

export const TYPE_META: Record<string, { icon: React.ReactElement | null; color: string }> = {
  text: { icon: null, color: "#007AFF" },
  image: { icon: null, color: "#34C759" },
  link: { icon: null, color: "#FF9500" },
  file: { icon: null, color: "#AF52DE" },
};
