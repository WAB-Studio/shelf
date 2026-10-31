import type { Locale } from "@/lib/locales";

// Seeded names are data, not interface strings: they are written into rows in
// the language active when the fund is created (RF-64) and renamed from then on
// (RF-63). Keying them by locale makes a missing translation a typecheck error.
export type SeedName = Record<Locale, string>;

export type SeedChild = {
  name: SeedName;
};

// A child carries neither `kind` nor `color`: a subcategory is the same kind as
// its parent (RF-27), and the writer copies both down.
export type SeedCategory = {
  kind: "expense" | "income";
  color: string;
  name: SeedName;
  children?: readonly SeedChild[];
};

// The shared pot's single cash account under `cash_mode = 'shared'` (RF-56).
export const GROUP_CASH_ACCOUNT_NAME: SeedName = {
  es: "Efectivo del grupo",
  en: "Group cash",
};

// A member's own cash account under `cash_mode = 'per_member'`; the leader's is
// seeded with the group (RF-56).
export const PERSONAL_CASH_ACCOUNT_NAME: SeedName = {
  es: "Mi efectivo",
  en: "My cash",
};

export const SEED_CATEGORIES: readonly SeedCategory[] = [
  {
    kind: "expense",
    color: "#E11D48",
    name: { es: "Vivienda", en: "Housing" },
    children: [
      { name: { es: "Arriendo", en: "Rent" } },
      { name: { es: "Servicios", en: "Utilities" } },
      { name: { es: "Internet", en: "Internet" } },
      { name: { es: "Mantenimiento", en: "Maintenance" } },
    ],
  },
  {
    kind: "expense",
    color: "#F97316",
    name: { es: "Mercado", en: "Groceries" },
  },
  {
    kind: "expense",
    color: "#F59E0B",
    name: { es: "Transporte", en: "Transport" },
    children: [
      { name: { es: "Combustible", en: "Fuel" } },
      { name: { es: "Transporte público", en: "Public transport" } },
    ],
  },
  {
    kind: "expense",
    color: "#10B981",
    name: { es: "Salud", en: "Health" },
  },
  {
    kind: "expense",
    color: "#06B6D4",
    name: { es: "Educación", en: "Education" },
  },
  {
    kind: "expense",
    color: "#8B5CF6",
    name: { es: "Ocio", en: "Leisure" },
    children: [
      { name: { es: "Restaurantes", en: "Eating out" } },
      { name: { es: "Suscripciones", en: "Subscriptions" } },
    ],
  },
  {
    kind: "expense",
    color: "#EC4899",
    name: { es: "Cuidado personal", en: "Personal care" },
  },
  {
    kind: "expense",
    color: "#A16207",
    name: { es: "Mascotas", en: "Pets" },
  },
  {
    kind: "expense",
    color: "#64748B",
    name: { es: "Impuestos y comisiones", en: "Taxes and fees" },
  },
  {
    // Cash discrepancies are written off here; the total measures how much
    // slips by unrecorded.
    kind: "expense",
    color: "#78716C",
    name: { es: "Sin registrar", en: "Unaccounted" },
  },
  {
    kind: "expense",
    color: "#475569",
    name: { es: "Otros gastos", en: "Other expenses" },
  },
  {
    kind: "income",
    color: "#16A34A",
    name: { es: "Salario", en: "Salary" },
  },
  {
    kind: "income",
    color: "#0EA5E9",
    name: { es: "Trabajo independiente", en: "Freelance" },
  },
  {
    kind: "income",
    color: "#14B8A6",
    name: { es: "Reembolsos", en: "Reimbursements" },
  },
  {
    kind: "income",
    color: "#6366F1",
    name: { es: "Otros ingresos", en: "Other income" },
  },
];
