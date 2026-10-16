// Adds one address to `goals.allowed_emails`, the list of people invited to GoalLog (RP-131).
// Usage: npm run allow-email -- <address>. Stored lowercase; the list is read by `isEmailAllowed`.
import postgres from "postgres";

const shape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<number> {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  if (!shape.test(email)) {
    console.error(`Correo no válido: «${process.argv[2] ?? ""}». Uso: npm run allow-email -- <correo>`);
    return 1;
  }
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const added = await sql`
      insert into goals.allowed_emails (email) values (${email})
      on conflict do nothing
      returning email`;
    console.log(added.length > 0 ? `${email}: agregado` : `${email}: ya estaba`);
    return 0;
  } finally {
    await sql.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
