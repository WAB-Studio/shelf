-- INSERT on `lookups` is granted column by column (0000), so a column 0005 added is refused until named here.
GRANT INSERT (definition, example_en, example_es)
  ON TABLE "reading"."lookups" TO "authenticated";
