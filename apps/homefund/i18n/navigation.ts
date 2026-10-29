import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

// Every internal navigation goes through these; `next/link` and `next/navigation` drop the locale.
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
