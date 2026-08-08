-- v0.5.0: manual hours are stored as normal events/slots with raw_json source=manual.
-- No additional table is required; this index speeds administrative lookup.
CREATE INDEX IF NOT EXISTS idx_slots_signupgenius_slot_id ON volunteer_slots(signupgenius_slot_id);
