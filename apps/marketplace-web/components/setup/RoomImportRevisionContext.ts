"use client";

import { createContext } from "react";

// Refresh canonical room reads after import without remounting an owner's unsaved editor.
export const RoomImportRevisionContext = createContext(0);
