-- Token Status List index allocator.
--
-- Replaces the previous `uuid_v4 & 0xfffff` scheme, which drew a 20-bit
-- value from a random UUID: ~1024 credentials hit a ~50% collision
-- (birthday bound), and a collision means revoking one credential flips
-- the status bit of another. A sequence is monotonic and unique.
--
-- START WITH 1048576 (0x100000) puts every new index strictly above the
-- old 20-bit range (legacy values were masked to <= 0xfffff), so a
-- sequence-allocated index can never alias a historical uuid-hash index
-- in the status-list bitstring projection.

CREATE SEQUENCE IF NOT EXISTS credential_status_idx_seq
    AS bigint
    MINVALUE 0
    START WITH 1048576
    INCREMENT BY 1
    NO CYCLE;

COMMENT ON SEQUENCE credential_status_idx_seq IS
    'Monotonic IETF Token Status List index per issued credential (draft-ietf-oauth-status-list).';
