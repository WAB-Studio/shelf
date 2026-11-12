-- The categories an English sign-in seeded before HomeFund stopped taking the browser's language (RF-195), renamed
-- to the Spanish seed names. Nothing marks a seeded row but the salary one, so a row is taken for seeded only when
-- its name is an English seed name exactly, with the seed kind, and a child sits under its English seed parent.
-- A rename that would collide with a category of the same name in the same scope is skipped, and each rename sees
-- the ones before it, so two rows cannot end on one name. Children go first, while their parent still reads English.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('Housing', 'Rent', 'Arriendo', 'expense'),
    ('Housing', 'Utilities', 'Servicios', 'expense'),
    ('Housing', 'Maintenance', 'Mantenimiento', 'expense'),
    ('Transport', 'Fuel', 'Combustible', 'expense'),
    ('Transport', 'Public transport', 'Transporte público', 'expense'),
    ('Leisure', 'Eating out', 'Restaurantes', 'expense'),
    ('Leisure', 'Subscriptions', 'Suscripciones', 'expense')
  ) AS t(parent_en, name_en, name_es, kind) LOOP
    UPDATE "finances"."categories" c SET "name" = r.name_es
    FROM "finances"."categories" p
    WHERE c."parent_id" = p."id" AND p."parent_id" IS NULL AND p."name" = r.parent_en AND p."kind" = r.kind
      AND p."owner_user_id" IS NOT DISTINCT FROM c."owner_user_id" AND p."group_id" IS NOT DISTINCT FROM c."group_id"
      AND c."name" = r.name_en AND c."kind" = r.kind
      AND NOT EXISTS (
        SELECT 1 FROM "finances"."categories" o
        WHERE o."name" = r.name_es AND o."owner_user_id" IS NOT DISTINCT FROM c."owner_user_id" AND o."group_id" IS NOT DISTINCT FROM c."group_id"
      );
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
    ('Housing', 'Vivienda', 'expense'),
    ('Groceries', 'Mercado', 'expense'),
    ('Transport', 'Transporte', 'expense'),
    ('Health', 'Salud', 'expense'),
    ('Education', 'Educación', 'expense'),
    ('Leisure', 'Ocio', 'expense'),
    ('Personal care', 'Cuidado personal', 'expense'),
    ('Pets', 'Mascotas', 'expense'),
    ('Taxes and fees', 'Impuestos y comisiones', 'expense'),
    ('Unaccounted', 'Sin registrar', 'expense'),
    ('Other expenses', 'Otros gastos', 'expense'),
    ('Salary', 'Salario', 'income'),
    ('Freelance', 'Trabajo independiente', 'income'),
    ('Reimbursements', 'Reembolsos', 'income'),
    ('Other income', 'Otros ingresos', 'income')
  ) AS t(name_en, name_es, kind) LOOP
    UPDATE "finances"."categories" c SET "name" = r.name_es
    WHERE c."parent_id" IS NULL AND c."name" = r.name_en AND c."kind" = r.kind
      AND NOT EXISTS (
        SELECT 1 FROM "finances"."categories" o
        WHERE o."name" = r.name_es AND o."owner_user_id" IS NOT DISTINCT FROM c."owner_user_id" AND o."group_id" IS NOT DISTINCT FROM c."group_id"
      );
  END LOOP;
END $$;
