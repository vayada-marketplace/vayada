import type pg from "pg";

import type { ParityHandler } from "../parityTypes.js";

export type TransformHandler = (client: pg.Client) => Promise<void>;

export type FixtureCaseRegistration = {
  fixtureCase: string;
  transform?: TransformHandler;
  parityHandlers?: ParityHandler[];
};
