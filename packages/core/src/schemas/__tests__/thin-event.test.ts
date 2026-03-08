import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ThinEventSchema } from "../thin-event.js";

const minimalValid = {
  event_id: "evt_123",
  event_type: "incident.created",
  incident_id: "inc_123",
  packet_id: "pkt_123",
};

describe("ThinEventSchema", () => {
  it("accepts a valid thin event", () => {
    const result = ThinEventSchema.parse(minimalValid);
    expect(result.event_id).toBe("evt_123");
    expect(result.event_type).toBe("incident.created");
  });

  it("requires event_id", () => {
    const { event_id: _, ...without } = minimalValid;
    expect(() => ThinEventSchema.parse(without)).toThrow(ZodError);
  });

  it("requires event_type to be the literal 'incident.created'", () => {
    expect(() =>
      ThinEventSchema.parse({ ...minimalValid, event_type: "incident.updated" })
    ).toThrow(ZodError);
  });

  it("requires incident_id", () => {
    const { incident_id: _, ...without } = minimalValid;
    expect(() => ThinEventSchema.parse(without)).toThrow(ZodError);
  });

  it("requires packet_id", () => {
    const { packet_id: _, ...without } = minimalValid;
    expect(() => ThinEventSchema.parse(without)).toThrow(ZodError);
  });

  it("rejects packet body fields (ADR 0020 non-goals) — strict schema throws", () => {
    const withPacketBody = {
      ...minimalValid,
      triggerSignals: [{ signal: "error_rate" }],
    };
    expect(() => ThinEventSchema.parse(withPacketBody)).toThrow(ZodError);
  });
});
