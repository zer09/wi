import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const SequenceSchema = z.number().int().nonnegative().safe();
export const EventSequenceSchema = z.number().int().positive().safe();
export const TimestampMsSchema = z.number().int().nonnegative().safe();

export const WireEnvelopeSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.string().min(1),
});

export type WireEnvelope = z.infer<typeof WireEnvelopeSchema>;
