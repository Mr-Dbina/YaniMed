-- Additive only: reject invalid existing rows rather than rewriting any data.
-- Checks and index become visible together, or the whole migration rolls back.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "public"."Subject"
    ADD CONSTRAINT "Subject_name_nonempty_check" CHECK (length("name") > 0),
    -- Match ECMAScript String.trim() whitespace, including tabs, newlines,
    -- nonbreaking spaces and BOM. Interior whitespace is allowed.
    ADD CONSTRAINT "Subject_name_trimmed_check" CHECK (
        "name" = btrim("name", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    );

-- Prisma cannot represent this expression index with @unique.
CREATE UNIQUE INDEX "Subject_name_lower_key" ON "public"."Subject" (lower("name"));

COMMIT;
