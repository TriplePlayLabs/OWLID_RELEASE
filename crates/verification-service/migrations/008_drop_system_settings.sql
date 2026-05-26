-- The system_settings table existed only to back the runtime
-- `midnight_enabled` toggle, which has been removed. Midnight is now
-- a hard runtime requirement (the service refuses to start without a
-- reachable sidecar), so the table has no remaining keys and no
-- callers.

DROP TABLE IF EXISTS system_settings;
