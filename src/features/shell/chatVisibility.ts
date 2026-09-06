import { createContext } from "react";

/** Retained upload owners may stay mounted while their mobile chat is hidden. */
export const ChatVisibilityContext = createContext(true);
