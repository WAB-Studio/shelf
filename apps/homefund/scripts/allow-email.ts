// Adds one address to `finances.allowed_emails`, the list of people invited to HomeFund (RF-145), and gives it a
// confirmed Auth user so its first sign-in link finds one. Usage: npm run allow-email -- <address>.
// The service-role key comes from this machine's environment alone: never `lib/env.ts`, never a Vercel project.
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const shape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<number> {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  if (!shape.test(email)) {
    console.error(`Correo no válido: «${process.argv[2] ?? ""}». Uso: npm run allow-email -- <correo>`);
    return 1;
  }

  // Listed before the user is created, so a failed create leaves it listed and a rerun completes it.
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const added = await sql`
      insert into finances.allowed_emails (email) values (${email})
      on conflict do nothing
      returning email`;
    console.log(added.length > 0 ? `${email}: agregado` : `${email}: ya estaba`);
  } finally {
    await sql.end();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Falta NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY: el correo quedó en la lista, sin usuario.");
    return 1;
  }
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  // `email_confirm` marks the address confirmed and sends nothing; an invite would mail it.
  const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (!error) {
    console.log(`${email}: usuario creado`);
    return 0;
  }
  if (error.code === "email_exists") {
    console.log(`${email}: ya tenía usuario`);
    return 0;
  }
  console.error(`No se pudo crear el usuario de ${email}: ${error.message}. Vuelve a correr el comando.`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
