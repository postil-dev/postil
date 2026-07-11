UPDATE "org_settings"
SET
	"model" = NULL,
	"model_cascade" = NULL
WHERE "org_id" IN (
	SELECT "id"
	FROM "organizations"
	WHERE "slug" = 'postil-dev'
);
