# Recuperación de Shelf (RF-191)

La base de Shelf (HomeFund, GoalLog, WordBook y TimeLog comparten el proyecto Supabase `mrxttyiyignnehcclsyx`) está en
el plan Free, que no guarda copias que se puedan restaurar. La copia es nuestra: cifrada y en un repositorio privado.

**Córrela cada domingo y antes de toda migración que borre o cambie datos.**

## Qué se copia

- `pg_dump` de los esquemas `finances`, `goals`, `reading`, `timelog`, `harness`, `drizzle` y `private` (las funciones que
  llaman los triggers y las políticas): estructura, datos y políticas.
- `auth.users` y `auth.identities`, solo las filas: todas las llaves foráneas terminan en un usuario.
- `rows.txt` (filas por tabla) y `meta.txt` (hora, versión del servidor, `pg_dump`, commit).
- No se copia: Vault, `cron`, `storage` ni los archivos de Storage, ni los secretos, que viven
  en Vercel y en el gestor de contraseñas. Los tokens de sesión (`auth.sessions`) tampoco: al restaurar todos vuelven a
  entrar.
- La copia no es de un solo instante: los conteos se toman justo después del volcado y una fila escrita en medio puede
  diferir (`finances.audit_log` crece sola).

## Dónde queda

Rama `copias` de `WAB-Studio/shelf-copias` (privado): un archivo `<hora UTC>.tar.gz.age` por copia, cifrado con age para
la llave pública de `scripts/backup/recipient.txt`. La rama se rehace en un solo commit cada vez y conserva solo los
últimos 35 días. Solo la llave privada `private/LLAVE-COPIAS-age.txt` (`AGE-SECRET-KEY-…`) las abre: guárdala en el gestor
de contraseñas, nunca en el repositorio ni en la nube.

## Hacer la copia

Requiere `age`, `psql`, y un `pg_dump` de la misma versión mayor que el servidor (17); el script se niega si no la
encuentra: instala `postgresql-client-17` o apunta `PG_BIN` a su carpeta `bin`. Solo lee producción.

1. Una vez: `git clone https://github.com/WAB-Studio/shelf-copias private/copias/shelf-copias`.
2. `scripts/backup/backup-encrypted.sh private/copias/shelf-copias`. Lee `MIGRATION_DATABASE_URL` del entorno o de
   `apps/homefund/.env.local`, hace la copia en `private/backups/`, la cifra, rehace la rama y la sube con tus credenciales
   de git. `scripts/backup/backup.sh` solo hace la copia, sin cifrar ni subir.

## Restaurar

1. Una base de Supabase vacía (proyecto nuevo o el stack local) con el esquema `auth`: los usuarios entran primero.
2. `scripts/backup/restore.sh <hora>.tar.gz.age <url-postgres> [--key llave.txt]`. Descifra, carga los usuarios y
   reconstruye los esquemas con `pg_restore --clean`: lo que hubiera en ellos se pierde. Se niega ante producción (el
   host de `MIGRATION_DATABASE_URL` o cualquiera de `supabase.co`/`supabase.com`) salvo que se pase `--production`.
3. Comparar con `rows.txt` de la copia (`age -d -i llave.txt <hora>.tar.gz.age | tar -xzOf - '*/rows.txt'`).
4. En un proyecto nuevo: activar las extensiones `pgcrypto` y `uuid-ossp`, y cambiar `DATABASE_URL` y
   `MIGRATION_DATABASE_URL` en Vercel de cada app.

## Simulacro (cada tres meses)

1. Hacer una copia y descifrarla: `age -d -i private/LLAVE-COPIAS-age.txt <hora>.tar.gz.age | tar -xzf - -C /ruta`.
2. Restaurarla en una base que no sea producción y comparar los conteos con `rows.txt`.
3. Anotar aquí fecha, duración y lo que falló.

| Fecha | Duración | Qué falló |
|---|---|---|
| 2026-11-11 | 1 min (copia 6,4 MB, 79 tablas, 103.351 filas) | Faltaba `private` en la primera copia: sus funciones no llegaron y fallaron los triggers; agregado. Los conteos coincidieron salvo `audit_log` (+3, escrito mientras tanto). |
