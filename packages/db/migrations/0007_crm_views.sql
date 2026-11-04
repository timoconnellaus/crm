-- Migration 0007: crm_* read views (ADR 0010, ADR 0015 amendment 2026-11-04).
--
-- D1/SQLite has no schemas, so the `crm.*` read surface is a set of views named `crm_<name>`
-- (`crm.people` is `crm_people`). They are what dashboard SQL, `query.sql` and list operations
-- read. Rules:
--   * Live rows only (deleted_at IS NULL).
--   * Friendly, stable column names; no secrets (crm_users has no auth columns).
--   * Each view selects from its core table aliased by the object name, so the stage-3 reconciler
--     can regenerate it with `LEFT JOIN x_<ext>_<object> USING (id)` for extension side tables
--     without changing core tables.
--   * Multi-valued fields are JSON arrays (emails, domains, tags).

CREATE VIEW crm_users AS
SELECT u.id, u.name, u.email, u.role, u.image, u.created_at
FROM core_user u;

CREATE VIEW crm_people AS
SELECT
  person.id,
  person.display_name,
  person.given_name,
  person.family_name,
  (SELECT e.email FROM core_person_emails e
    WHERE e.person_id = person.id AND e.is_primary = 1) AS primary_email,
  (SELECT json_group_array(e.email) FROM
    (SELECT email FROM core_person_emails WHERE person_id = person.id ORDER BY position) e) AS emails,
  (SELECT ph.number FROM core_person_phones ph
    WHERE ph.person_id = person.id AND ph.is_primary = 1) AS primary_phone,
  aff.id AS primary_affiliation_id,
  aff.title AS job_title,
  aff.organisation_id AS organisation_id,
  org.name AS organisation_name,
  person.location,
  person.timezone,
  person.owner_id,
  person.avatar_key,
  (SELECT json_group_array(t.name) FROM
    (SELECT tg.name FROM core_record_tags rt JOIN core_tags tg ON tg.id = rt.tag_id
      WHERE rt.object_type = 'person' AND rt.record_id = person.id ORDER BY tg.name) t) AS tags,
  person.created_at,
  person.updated_at
FROM core_person person
LEFT JOIN core_affiliation aff
  ON aff.person_id = person.id AND aff.is_primary = 1 AND aff.deleted_at IS NULL
LEFT JOIN core_organisation org
  ON org.id = aff.organisation_id AND org.deleted_at IS NULL
WHERE person.deleted_at IS NULL;

CREATE VIEW crm_organisations AS
SELECT
  organisation.id,
  organisation.name,
  (SELECT d.domain FROM core_organisation_domains d
    WHERE d.organisation_id = organisation.id AND d.is_primary = 1) AS primary_domain,
  (SELECT json_group_array(d.domain) FROM
    (SELECT domain FROM core_organisation_domains WHERE organisation_id = organisation.id
      ORDER BY position) d) AS domains,
  organisation.website,
  organisation.industry,
  organisation.parent_id,
  parent.name AS parent_name,
  organisation.owner_id,
  organisation.avatar_key,
  (SELECT COUNT(*) FROM core_affiliation a JOIN core_person p ON p.id = a.person_id
    WHERE a.organisation_id = organisation.id AND a.is_current = 1
      AND a.deleted_at IS NULL AND p.deleted_at IS NULL) AS current_people_count,
  (SELECT json_group_array(t.name) FROM
    (SELECT tg.name FROM core_record_tags rt JOIN core_tags tg ON tg.id = rt.tag_id
      WHERE rt.object_type = 'organisation' AND rt.record_id = organisation.id
      ORDER BY tg.name) t) AS tags,
  organisation.created_at,
  organisation.updated_at
FROM core_organisation organisation
LEFT JOIN core_organisation parent
  ON parent.id = organisation.parent_id AND parent.deleted_at IS NULL
WHERE organisation.deleted_at IS NULL;

CREATE VIEW crm_affiliations AS
SELECT
  affiliation.id,
  affiliation.person_id,
  affiliation.organisation_id,
  affiliation.title,
  affiliation.role,
  affiliation.started_on,
  affiliation.ended_on,
  affiliation.is_current,
  affiliation.is_primary,
  affiliation.created_at,
  affiliation.updated_at
FROM core_affiliation affiliation
JOIN core_person p ON p.id = affiliation.person_id AND p.deleted_at IS NULL
JOIN core_organisation o ON o.id = affiliation.organisation_id AND o.deleted_at IS NULL
WHERE affiliation.deleted_at IS NULL;

CREATE VIEW crm_activities AS
SELECT
  activity.id,
  activity.type,
  activity.subject,
  activity.body,
  activity.payload,
  activity.occurred_at,
  activity.author_user_id,
  activity.author_actor,
  activity.created_at,
  activity.updated_at
FROM core_activity activity
WHERE activity.deleted_at IS NULL;

CREATE VIEW crm_activity_links AS
SELECT l.activity_id, l.object_type, l.record_id
FROM core_activity_links l
JOIN core_activity a ON a.id = l.activity_id AND a.deleted_at IS NULL;

CREATE VIEW crm_tasks AS
SELECT
  task.id,
  task.title,
  task.notes,
  task.due_at,
  task.status,
  task.completed_at,
  task.assignee_id,
  task.created_by,
  task.created_at,
  task.updated_at
FROM core_task task
WHERE task.deleted_at IS NULL;

CREATE VIEW crm_task_links AS
SELECT l.task_id, l.object_type, l.record_id
FROM core_task_links l
JOIN core_task t ON t.id = l.task_id AND t.deleted_at IS NULL;

CREATE VIEW crm_record_tags AS
SELECT rt.object_type, rt.record_id, tg.id AS tag_id, tg.name AS tag
FROM core_record_tags rt
JOIN core_tags tg ON tg.id = rt.tag_id;

UPDATE core_meta SET value = '7' WHERE key = 'schema_version';
