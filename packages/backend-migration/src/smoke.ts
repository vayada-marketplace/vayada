import { getRegisteredFixtureCases } from "./cases/registry.js";

export function getSmokeFixtureCases(): string[] {
  return getRegisteredFixtureCases();
}
