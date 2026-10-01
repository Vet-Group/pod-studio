-- Existing owners need the new library permissions to grant them down the chain of trust.
-- Preserve every other membership exactly; never expand global-admin or non-owner grants.
WITH changed AS (
  UPDATE store_members
  SET permissions = permissions || ARRAY(
    SELECT permission FROM unnest(ARRAY['design.upload', 'design.share']::text[]) AS permission
    WHERE NOT permission = ANY(store_members.permissions)
  ), updated_at = now()
  WHERE role = 'owner' AND NOT permissions @> ARRAY['design.upload', 'design.share']::text[]
  RETURNING id, store_id, permissions
)
INSERT INTO audit_log (id, actor_kind, store_id, action, target_type, target_id, data)
SELECT 'library_' || substr(md5(id), 1, 21), 'system', store_id,
  'store.member.library.upgrade', 'store_member', id,
  jsonb_build_object('permissions', permissions)
FROM changed;