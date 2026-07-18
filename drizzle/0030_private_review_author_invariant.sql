CREATE OR REPLACE FUNCTION enforce_private_review_author_identity() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM repositories
    WHERE repositories.id = NEW.repository_id
      AND repositories.private = true
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('postil:private-review-author-v1', 0));
  IF NOT EXISTS (
    SELECT 1
    FROM deployment_capabilities
    WHERE deployment_capabilities.name = 'private-review-author-v1'
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.author_github_id IS DISTINCT FROM NEW.author_github_id
       OR OLD.author_login IS DISTINCT FROM NEW.author_login
     ) THEN
    RAISE EXCEPTION 'private review author identity is immutable';
  END IF;

  IF NEW.status IN ('queued', 'running', 'completed')
     AND (
       NEW.author_github_id IS NULL
       OR NEW.author_github_id <= 0
       OR NEW.author_github_id > 9007199254740991
       OR NEW.author_login IS NULL
       OR length(btrim(NEW.author_login)) = 0
       OR length(NEW.author_login) > 100
     ) THEN
    RAISE EXCEPTION 'private review author identity is required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reviews_private_author_identity_required
BEFORE INSERT OR UPDATE OF status, repository_id, author_github_id, author_login ON reviews
FOR EACH ROW EXECUTE FUNCTION enforce_private_review_author_identity();
