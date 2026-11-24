import { describe, expect, it } from "vitest";

import { createCallLimit } from "./callLimit.js";

describe("createCallLimit", () => {
  it("lets a waiting call in when a running one finishes, in arrival order", async () => {
    const limit = createCallLimit(1, 1_000);
    const first = await limit.acquire();
    const order: string[] = [];
    const second = limit.acquire().then((release) => (order.push("second"), release));
    const third = limit.acquire().then((release) => (order.push("third"), release));

    first!();
    first!(); // a second release of the same place changes nothing
    (await second)!();
    (await third)!();

    expect(order).toEqual(["second", "third"]);
  });

  it("gives up after the wait and does not hand the place out later", async () => {
    const limit = createCallLimit(1, 10);
    const first = await limit.acquire();

    expect(await limit.acquire()).toBeNull();

    first!();
    const next = await limit.acquire();
    expect(next).toBeTypeOf("function");
    // The only place is taken again, so a further call waits and then gives up.
    expect(await limit.acquire()).toBeNull();
  });
});
