import { expect, it } from "vitest";
import {
  groupRoomsByType,
  moveRoomType,
  moveRoomWithinType,
  orderRoomsByRoomType,
} from "./roomOrdering";

it("uses the Rooms & Rates type sequence and preserves saved order within each type", () => {
  const rooms = [
    { roomTypeId: "twin", roomNumber: "2" },
    { roomTypeId: "double", roomNumber: "10" },
    { roomTypeId: "missing", roomNumber: "101" },
    { roomTypeId: "double", roomNumber: "2" },
    { roomTypeId: "twin", roomNumber: "1" },
  ];
  const original = [...rooms];
  expect(orderRoomsByRoomType(rooms, ["double", "empty", "twin"])).toEqual([
    rooms[1],
    rooms[3],
    rooms[0],
    rooms[4],
    rooms[2],
  ]);
  expect(rooms).toEqual(original);
  expect(orderRoomsByRoomType(rooms, [])).toEqual(rooms);
  expect(orderRoomsByRoomType([], ["double"])).toEqual([]);
});

const rooms = [
  { id: "101", roomTypeId: "double" },
  { id: "102", roomTypeId: "double" },
  { id: "suite", roomTypeId: "suite" },
  { id: "201", roomTypeId: "twin" },
  { id: "202", roomTypeId: "twin" },
];
const ids = (list: readonly { id: string }[]) => list.map(({ id }) => id);

it("groups rooms by type in first-appearance order", () => {
  expect(
    groupRoomsByType([...rooms, { id: "103", roomTypeId: "double" }]).map(
      ({ roomTypeId, rooms: grouped }) => [roomTypeId, ids(grouped)],
    ),
  ).toEqual([
    ["double", ["101", "102", "103"]],
    ["suite", ["suite"]],
    ["twin", ["201", "202"]],
  ]);
});

it("moves a whole room type past its neighbour (VAY-2294)", () => {
  expect(ids(moveRoomType(rooms, "suite", -1))).toEqual(["suite", "101", "102", "201", "202"]);
  expect(ids(moveRoomType(rooms, "double", 1))).toEqual(["suite", "101", "102", "201", "202"]);
  expect(ids(moveRoomType(rooms, "twin", -1))).toEqual(["101", "102", "201", "202", "suite"]);
  expect(ids(moveRoomType(rooms, "double", -1))).toEqual(ids(rooms));
  expect(ids(moveRoomType(rooms, "twin", 1))).toEqual(ids(rooms));
  expect(ids(moveRoomType(rooms, "missing", 1))).toEqual(ids(rooms));
});

it("moves a room only within its own type", () => {
  expect(ids(moveRoomWithinType(rooms, "101", 1))).toEqual(["102", "101", "suite", "201", "202"]);
  expect(ids(moveRoomWithinType(rooms, "202", -1))).toEqual(["101", "102", "suite", "202", "201"]);
  expect(ids(moveRoomWithinType(rooms, "102", 1))).toEqual(ids(rooms));
  expect(ids(moveRoomWithinType(rooms, "101", -1))).toEqual(ids(rooms));
  expect(ids(moveRoomWithinType(rooms, "missing", 1))).toEqual(ids(rooms));
});
