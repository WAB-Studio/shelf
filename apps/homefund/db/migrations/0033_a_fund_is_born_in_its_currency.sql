-- RF-121: `groups.currency` has been written at creation since the fund declares what it settles
-- in, and only `UPDATE (currency)` was ever granted — 0000 gave `INSERT (id, name, cash_mode)` and
-- 0031 widened the update alone. So a leader could change the currency of a fund they could no
-- longer create: the INSERT takes 42501 for the column, not the empty answer a denied policy gives,
-- and the whole of `createGroup` rolls back with it. Column-scoped like every grant here: `id` is
-- the caller's own uuid because an unclaimed group fails its SELECT policy, and the rest of the row
-- stays with the defaults and the triggers.
GRANT INSERT (currency) ON TABLE "groups" TO authenticated;
