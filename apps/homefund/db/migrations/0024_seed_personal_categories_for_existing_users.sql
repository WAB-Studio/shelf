-- RF-64 seeds a user's personal categories from the row count of the `app_users` insert in the
-- confirm route, so only a first sign-in that lands a row seeds one. Everyone who signed in before
-- that commit — 4 of the 5 live users, the repository owner among them — holds zero personal
-- categories, and RF-69 makes a split mandatory on every expense: they cannot record one at all.
--
-- A one-time historical repair, so the set is written out here instead of read from
-- `SEED_CATEGORIES`: a migration is a fact about a moment, and a later edit to that constant must
-- not rewrite what this applied. The two copies are expected to diverge.
--
-- Scope: a user with even one personal category is left untouched; `owner_user_id` is null on every
-- group category, so a group's set never counts as one. `capture_audit` records the 92 rows with a
-- null actor, which is what marks a system write (RF-45).
--
-- The two inserts are separate statements inside a loop because `assert_category_depth` reads the
-- parent back out of `categories`: a subcategory inserted in the same statement as its parent would
-- not find it.
do $$
declare
  t record;
begin
  for t in
    select u.id, u.locale
    from public.app_users u
    where not exists (select 1 from public.categories c where c.owner_user_id = u.id)
  loop
    insert into public.categories (owner_user_id, name, kind, color)
    select t.id,
           case t.locale when 'en' then s.name_en else s.name_es end,
           s.kind,
           s.color
    from (values
      ('expense', '#E11D48', 'Vivienda', 'Housing'),
      ('expense', '#F97316', 'Mercado', 'Groceries'),
      ('expense', '#F59E0B', 'Transporte', 'Transport'),
      ('expense', '#10B981', 'Salud', 'Health'),
      ('expense', '#06B6D4', 'Educación', 'Education'),
      ('expense', '#8B5CF6', 'Ocio', 'Leisure'),
      ('expense', '#EC4899', 'Cuidado personal', 'Personal care'),
      ('expense', '#A16207', 'Mascotas', 'Pets'),
      ('expense', '#64748B', 'Impuestos y comisiones', 'Taxes and fees'),
      ('expense', '#78716C', 'Sin registrar', 'Unaccounted'),
      ('expense', '#475569', 'Otros gastos', 'Other expenses'),
      ('income', '#16A34A', 'Salario', 'Salary'),
      ('income', '#0EA5E9', 'Trabajo independiente', 'Freelance'),
      ('income', '#14B8A6', 'Reembolsos', 'Reimbursements'),
      ('income', '#6366F1', 'Otros ingresos', 'Other income')
    ) as s(kind, color, name_es, name_en);

    -- A subcategory copies its parent's kind and colour (RF-63), and names its parent by the same
    -- localised name the statement above just wrote, which is unique inside one user's set.
    insert into public.categories (owner_user_id, parent_id, name, kind, color)
    select t.id,
           p.id,
           case t.locale when 'en' then k.name_en else k.name_es end,
           p.kind,
           p.color
    from (values
      ('Vivienda', 'Housing', 'Arriendo', 'Rent'),
      ('Vivienda', 'Housing', 'Servicios', 'Utilities'),
      ('Vivienda', 'Housing', 'Internet', 'Internet'),
      ('Vivienda', 'Housing', 'Mantenimiento', 'Maintenance'),
      ('Transporte', 'Transport', 'Combustible', 'Fuel'),
      ('Transporte', 'Transport', 'Transporte público', 'Public transport'),
      ('Ocio', 'Leisure', 'Restaurantes', 'Eating out'),
      ('Ocio', 'Leisure', 'Suscripciones', 'Subscriptions')
    ) as k(parent_es, parent_en, name_es, name_en)
    join public.categories p
      on p.owner_user_id = t.id
     and p.parent_id is null
     and p.name = case t.locale when 'en' then k.parent_en else k.parent_es end;
  end loop;
end $$;
