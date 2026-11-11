-- RF-134: a re-import renumbers the legs it keeps by deleting and re-inserting their source rows. The
-- row goes back in with the moment it first came in, so a line this import created stays the one a
-- later re-import may delete.
GRANT INSERT (created_at) ON TABLE "finances"."transaction_sources" TO authenticated;
