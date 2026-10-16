/**
 * A full app for a demo user: five accounts, ten months of movements, and one
 * row of every planning entity, so no screen is judged empty. Everything is
 * written THROUGH the app's own query functions — the ledger, the budgets, the
 * goals, the debts and the recurring generator are the ones the app would have
 * written, not SQL invented here.
 *
 * Repeatable: every movement carries an `external_ref` derived from its date and
 * its slot, and every other entity is found again by the name it shows on screen,
 * so a second run tops the fixture up instead of doubling it. `drop` deletes
 * exactly what those names reach, under the seeded user's own claims, then
 * purges the trail those deletes and the seed itself left — which returns every
 * table, `audit_log` included, to the count it found.
 *
 * Usage:
 *   npm run seed:demo          # fill the app for the demo user
 *   npm run seed:demo:drop     # take it all back out
 *   npm run seed:demo -- count # census only, writing nothing
 *
 * The user defaults to the person the design is judged by; `--email=` names
 * another.
 */
import { createAccount, listAccounts } from "@/db/queries/accounts";
import {
  archiveBudget,
  createBudget,
  listBudgetsWithStatus,
  updateBudget,
} from "@/db/queries/budgets";
import { createCategory, listScopedCategories } from "@/db/queries/categories";
import { recordBilledAmount } from "@/db/queries/debt-statements";
import { upsertDebtTerms } from "@/db/queries/debt-terms";
import {
  createInstallmentPlan,
  listPlansForAccount,
  recordDebtPayment,
} from "@/db/queries/installment-plans";
import { createLabel, listLabels } from "@/db/queries/labels";
import {
  cancelPlannedPayment,
  createPlannedPayment,
  listPlannedPayments,
  settlePlannedPayment,
} from "@/db/queries/planned-payments";
import {
  createRecurringRule,
  listRecurringRules,
  markTransactionReviewed,
  setRecurringRuleActive,
} from "@/db/queries/recurring-rules";
import {
  addGoalContribution,
  archiveGoal,
  createGoal,
  listGoalsWithProgress,
} from "@/db/queries/savings-goals";
import {
  createTransaction,
  insertTransaction,
  listTransactions,
} from "@/db/queries/transactions";
import type { CreateTransactionArgs } from "@/db/queries/transactions";
import { withUserDb } from "@/db/session";
import { BASE_CURRENCY, type OfferedCurrency } from "@/lib/currency";
import { addCivilDays, addCivilMonths, todayInBogota } from "@/lib/dates";
import { pesosToCents } from "@/lib/money";

import { asOwner, fixtureSql, findUserByEmail, purgeAuditTrail } from "./harness/fixtures";
import type { HarnessUser } from "./harness/fixtures";

// The user the fixture fills the app for. Named here rather than taken from the
// harness identity: this seed exists to be looked at, not to be measured.
const DEMO_EMAIL = "wilsonparada0111@gmail.com";

// The `external_ref` every hand-written movement carries, which is what makes
// the ledger repeatable. The movements the app writes for itself — a settled
// payment, a debt payment, a generated recurrence — carry their own id instead,
// so the drop reaches them through the accounts they touch.
const SEED_PREFIX = "demo:";

// Ten months of history, the current one included.
const MONTHS_BACK = 9;

// Movements per commit, and commits in flight at once, as `seed-year.ts` sizes
// them: the driver sends one statement at a time, so concurrency is what buys
// the throughput back from the pooler's latency.
const BATCH = 32;
const PARALLEL = 8;

type AccountKey = "savings" | "nequi" | "cash" | "visa" | "falabella" | "usd";

type DemoAccount = {
  key: AccountKey;
  name: string;
  kind: "asset" | "liability";
  subtype: "bancaria" | "efectivo" | "tarjeta";
  institution: string | null;
  lastFour: string | null;
  // Where the account settles (RF-121): every existing account keeps the peso,
  // and the one dollar account is what gives the fixture a second currency to
  // hold and to move between (RF-122).
  settlementCurrency: OfferedCurrency;
  // What the account held the day before the oldest movement, in the major unit
  // of its OWN settlement currency — pesos for a COP account, dollars for the
  // USD one. `pesosToCents` reads either the same way: the stored scale is
  // hundredths of the major unit for every currency alike (RNF-05).
  openingAmount: number;
};

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    key: "savings",
    name: "Ahorros Bancolombia",
    kind: "asset",
    subtype: "bancaria",
    institution: "Bancolombia",
    lastFour: "4082",
    settlementCurrency: "COP",
    openingAmount: 4_200_000,
  },
  {
    key: "nequi",
    name: "Nequi",
    kind: "asset",
    subtype: "bancaria",
    institution: "Nequi",
    lastFour: "7731",
    settlementCurrency: "COP",
    openingAmount: 350_000,
  },
  {
    key: "cash",
    name: "Efectivo",
    kind: "asset",
    subtype: "efectivo",
    institution: null,
    lastFour: null,
    settlementCurrency: "COP",
    openingAmount: 120_000,
  },
  {
    key: "usd",
    name: "Payoneer USD",
    kind: "asset",
    subtype: "bancaria",
    institution: "Payoneer",
    lastFour: null,
    settlementCurrency: "USD",
    openingAmount: 650,
  },
  {
    key: "visa",
    name: "Tarjeta Visa Bancolombia",
    kind: "liability",
    subtype: "tarjeta",
    institution: "Bancolombia",
    lastFour: "5519",
    settlementCurrency: "COP",
    openingAmount: 1_200_000,
  },
  {
    key: "falabella",
    name: "Tarjeta CMR Falabella",
    kind: "liability",
    subtype: "tarjeta",
    institution: "Banco Falabella",
    lastFour: "9204",
    settlementCurrency: "COP",
    openingAmount: 5_000_000,
  },
];

// The one level of hierarchy the categories screen shows off. The 23 categories
// the user already owns stay untouched; these hang under three of them, and the
// insert takes each parent's colour by itself.
const DEMO_SUBCATEGORIES = [
  { name: "Supermercado", parent: "Mercado" },
  { name: "Fruver", parent: "Mercado" },
  { name: "Gimnasio", parent: "Salud" },
  { name: "Cursos", parent: "Educación" },
];

const DEMO_LABELS = [
  { name: "Viaje Cartagena", color: "#0EA5E9" },
  { name: "Trabajo", color: "#6366F1" },
  { name: "Regalos", color: "#EC4899" },
  { name: "Emergencia", color: "#F97316" },
];

// One line of a month's ledger. `days` fires the recipe once per named day of the
// month; `everyNMonths` thins it out on a fixed phase, so a re-run picks the same
// months. A transfer names both accounts and carries no split (RF-19); an income
// names only `to`, an expense only `from`.
type Recipe = {
  slot: string;
  days: number[];
  everyNMonths?: number;
  phase?: number;
  from: AccountKey | null;
  to: AccountKey | null;
  pesos: number;
  description: string;
  splits?: { category: string; weight: number }[];
  label?: string;
};

const RECIPES: Recipe[] = [
  // Income: a fortnightly payroll, freelance work every other month, the odd refund.
  {
    slot: "nomina-1",
    days: [1],
    from: null,
    to: "savings",
    pesos: 2_450_000,
    description: "Nómina primera quincena",
    splits: [{ category: "Salario", weight: 1 }],
  },
  {
    slot: "nomina-2",
    days: [15],
    from: null,
    to: "savings",
    pesos: 2_450_000,
    description: "Nómina segunda quincena",
    splits: [{ category: "Salario", weight: 1 }],
  },
  {
    slot: "freelance",
    days: [9],
    everyNMonths: 2,
    from: null,
    to: "nequi",
    pesos: 850_000,
    description: "Diseño para cliente",
    splits: [{ category: "Trabajo independiente", weight: 1 }],
    label: "Trabajo",
  },
  {
    slot: "reembolso",
    days: [21],
    everyNMonths: 3,
    phase: 1,
    from: null,
    to: "savings",
    pesos: 145_000,
    description: "Reembolso de la EPS",
    splits: [{ category: "Reembolsos", weight: 1 }],
  },
  // Housing and services.
  {
    slot: "arriendo",
    days: [1],
    from: "savings",
    to: null,
    pesos: 1_350_000,
    description: "Arriendo",
    splits: [{ category: "Arriendo", weight: 1 }],
  },
  {
    slot: "servicios",
    days: [2],
    from: "savings",
    to: null,
    pesos: 210_000,
    description: "Energía y acueducto",
    splits: [{ category: "Servicios", weight: 1 }],
  },
  {
    slot: "internet",
    days: [4],
    from: "savings",
    to: null,
    pesos: 89_900,
    description: "Internet del apartamento",
    splits: [{ category: "Internet", weight: 1 }],
  },
  {
    slot: "mantenimiento",
    days: [11],
    everyNMonths: 3,
    from: "savings",
    to: null,
    pesos: 185_000,
    description: "Arreglo de la ducha",
    splits: [{ category: "Mantenimiento", weight: 1 }],
    label: "Emergencia",
  },
  // Groceries: the weekly run under the subcategory, the fruit stand in cash, and
  // one monthly shop split across two categories.
  {
    slot: "mercado",
    days: [3, 10, 17, 24],
    from: "savings",
    to: null,
    pesos: 178_000,
    description: "Mercado de la semana",
    splits: [{ category: "Supermercado", weight: 1 }],
  },
  {
    slot: "fruver",
    days: [6, 20],
    from: "cash",
    to: null,
    pesos: 38_000,
    description: "Frutas y verduras",
    splits: [{ category: "Fruver", weight: 1 }],
  },
  {
    slot: "compra-mes",
    days: [12],
    from: "savings",
    to: null,
    pesos: 246_000,
    description: "Compra grande del mes",
    splits: [
      { category: "Mercado", weight: 7 },
      { category: "Cuidado personal", weight: 3 },
    ],
  },
  // Eating out.
  {
    slot: "almuerzo",
    days: [2, 8, 14, 22, 27],
    from: "nequi",
    to: null,
    pesos: 28_000,
    description: "Almuerzo",
    splits: [{ category: "Restaurantes", weight: 1 }],
  },
  {
    slot: "cena",
    days: [16],
    from: "visa",
    to: null,
    pesos: 96_000,
    description: "Cena afuera",
    splits: [{ category: "Restaurantes", weight: 1 }],
  },
  // Getting around.
  {
    slot: "bus",
    days: [1, 3, 7, 10, 14, 18, 22, 26],
    from: "cash",
    to: null,
    pesos: 5_800,
    description: "Transporte del día",
    splits: [{ category: "Transporte público", weight: 1 }],
  },
  {
    slot: "gasolina",
    days: [2, 19],
    from: "visa",
    to: null,
    pesos: 120_000,
    description: "Gasolina",
    splits: [{ category: "Combustible", weight: 1 }],
    label: "Trabajo",
  },
  // The rest of the month.
  {
    slot: "suscripciones",
    days: [5],
    from: "visa",
    to: null,
    pesos: 38_900,
    description: "Streaming",
    splits: [{ category: "Suscripciones", weight: 1 }],
  },
  {
    slot: "ocio",
    days: [13, 23],
    from: "nequi",
    to: null,
    pesos: 72_000,
    description: "Cine y salida",
    splits: [{ category: "Ocio", weight: 1 }],
  },
  {
    slot: "regalo",
    days: [23],
    everyNMonths: 3,
    phase: 2,
    from: "visa",
    to: null,
    pesos: 165_000,
    description: "Regalo de cumpleaños",
    splits: [{ category: "Ocio", weight: 1 }],
    label: "Regalos",
  },
  {
    slot: "gimnasio",
    days: [7],
    from: "savings",
    to: null,
    pesos: 110_000,
    description: "Mensualidad del gimnasio",
    splits: [{ category: "Gimnasio", weight: 1 }],
  },
  {
    slot: "salud",
    days: [18],
    from: "savings",
    to: null,
    pesos: 95_000,
    description: "Consulta médica",
    splits: [{ category: "Salud", weight: 1 }],
  },
  {
    slot: "peluqueria",
    days: [26],
    from: "cash",
    to: null,
    pesos: 45_000,
    description: "Peluquería",
    splits: [{ category: "Cuidado personal", weight: 1 }],
  },
  {
    slot: "mascotas",
    days: [21],
    from: "savings",
    to: null,
    pesos: 78_000,
    description: "Comida y veterinario",
    splits: [{ category: "Mascotas", weight: 1 }],
  },
  {
    slot: "curso",
    days: [8],
    everyNMonths: 2,
    phase: 1,
    from: "savings",
    to: null,
    pesos: 150_000,
    description: "Curso de inglés",
    splits: [{ category: "Cursos", weight: 1 }],
  },
  {
    slot: "comision",
    days: [28],
    from: "savings",
    to: null,
    pesos: 12_500,
    description: "Comisión bancaria",
    splits: [{ category: "Impuestos y comisiones", weight: 1 }],
  },
  {
    slot: "otros",
    days: [29],
    from: "nequi",
    to: null,
    pesos: 45_000,
    description: "Gasto sin clasificar",
    splits: [{ category: "Otros gastos", weight: 1 }],
  },
  // Two movements that split three ways, so a shared expense is on screen.
  {
    slot: "mudanza",
    days: [24],
    everyNMonths: 2,
    from: "savings",
    to: null,
    pesos: 320_000,
    description: "Arreglos de la casa",
    splits: [
      { category: "Vivienda", weight: 5 },
      { category: "Mercado", weight: 3 },
      { category: "Otros gastos", weight: 2 },
    ],
  },
  {
    slot: "viaje",
    days: [15],
    everyNMonths: 4,
    phase: 2,
    from: "visa",
    to: null,
    pesos: 780_000,
    description: "Fin de semana en Cartagena",
    splits: [
      { category: "Ocio", weight: 6 },
      { category: "Restaurantes", weight: 4 },
    ],
    label: "Viaje Cartagena",
  },
  // Movements between the user's own accounts: two withdrawals to cash, one
  // top-up of the wallet, and a payment to each card.
  {
    slot: "retiro-1",
    days: [2],
    from: "savings",
    to: "cash",
    pesos: 120_000,
    description: "Retiro en cajero",
  },
  {
    slot: "retiro-2",
    days: [17],
    from: "savings",
    to: "cash",
    pesos: 90_000,
    description: "Retiro en cajero",
  },
  {
    slot: "traslado-nequi",
    days: [5],
    from: "savings",
    to: "nequi",
    pesos: 400_000,
    description: "Traslado a Nequi",
  },
  {
    slot: "pago-visa",
    days: [20],
    from: "savings",
    to: "visa",
    pesos: 600_000,
    description: "Pago tarjeta Visa",
  },
  {
    slot: "pago-falabella",
    days: [25],
    from: "savings",
    to: "falabella",
    pesos: 250_000,
    description: "Pago tarjeta Falabella",
  },
];

// The budgets, by the name each one shows. The limit is not written here: it is
// derived from what the seeded month actually spent, so the roomy one stays
// roomy, the second lands over its threshold and the third over its limit
// whatever the movements came to.
type BudgetPlan = {
  name: string;
  category: string;
  period: "weekly" | "monthly" | "yearly";
  thresholdPct: number;
  account: AccountKey | null;
  label: string | null;
  // What fraction of the limit the seeded spend should come to.
  usedPct: number;
  archived?: boolean;
};

const DEMO_BUDGETS: BudgetPlan[] = [
  {
    name: "Servicios del hogar",
    category: "Servicios",
    period: "monthly",
    thresholdPct: 80,
    account: null,
    label: null,
    usedPct: 25,
  },
  {
    name: "Comidas fuera",
    category: "Restaurantes",
    period: "monthly",
    thresholdPct: 80,
    account: null,
    label: null,
    usedPct: 90,
  },
  {
    name: "Transporte del mes",
    category: "Transporte público",
    period: "monthly",
    thresholdPct: 80,
    account: null,
    label: null,
    usedPct: 140,
  },
  {
    name: "Mercado de la semana",
    category: "Supermercado",
    period: "weekly",
    thresholdPct: 75,
    account: null,
    label: null,
    usedPct: 35,
  },
  {
    name: "Gasolina con la Visa",
    category: "Combustible",
    period: "monthly",
    thresholdPct: 80,
    account: "visa",
    label: null,
    usedPct: 50,
  },
  {
    name: "Regalos de fin de año",
    category: "Ocio",
    period: "monthly",
    thresholdPct: 80,
    account: null,
    label: "Regalos",
    usedPct: 60,
    archived: true,
  },
];

// What a budget is given when its window holds no movement at all: a limit of
// zero is one no screen can draw a bar against.
const EMPTY_BUDGET_LIMIT_PESOS = 50_000;

type GoalPlan = {
  name: string;
  targetPesos: number;
  // Months from today; negative dates a goal that should already have landed.
  targetMonths: number | null;
  account: AccountKey | null;
  contributionsPesos: number[];
  archived?: boolean;
};

const DEMO_GOALS: GoalPlan[] = [
  {
    name: "Viaje a Cartagena",
    targetPesos: 6_000_000,
    targetMonths: 4,
    account: "savings",
    contributionsPesos: [800_000, 1_200_000, 900_000, 500_000],
  },
  {
    name: "Fondo de emergencia",
    targetPesos: 12_000_000,
    targetMonths: -2,
    account: null,
    contributionsPesos: [1_500_000, 1_500_000, 900_000, 700_000],
  },
  {
    name: "Portátil nuevo",
    targetPesos: 4_500_000,
    targetMonths: 1,
    account: null,
    contributionsPesos: [2_000_000, 1_500_000, 800_000, 150_000],
  },
  {
    name: "Curso de inglés B2",
    targetPesos: 1_200_000,
    targetMonths: -4,
    account: null,
    contributionsPesos: [600_000, 600_000],
    archived: true,
  },
];

type PaymentPlan = {
  description: string;
  pesos: number;
  // Days from today; a negative one is already due.
  dueInDays: number;
  from: AccountKey;
  category: string;
  outcome: "pending" | "settled" | "cancelled";
};

const DEMO_PAYMENTS: PaymentPlan[] = [
  {
    description: "Matrícula del semestre",
    pesos: 1_800_000,
    dueInDays: 12,
    from: "savings",
    category: "Cursos",
    outcome: "pending",
  },
  {
    description: "Seguro del carro",
    pesos: 640_000,
    dueInDays: 25,
    from: "nequi",
    category: "Otros gastos",
    outcome: "pending",
  },
  {
    description: "Impuesto predial",
    pesos: 420_000,
    dueInDays: -6,
    from: "savings",
    category: "Impuestos y comisiones",
    outcome: "pending",
  },
  {
    description: "Mensualidad del gimnasio",
    pesos: 110_000,
    dueInDays: -20,
    from: "savings",
    category: "Gimnasio",
    outcome: "settled",
  },
  {
    description: "Suscripción anual de música",
    pesos: 180_000,
    dueInDays: -10,
    from: "nequi",
    category: "Suscripciones",
    outcome: "cancelled",
  },
];

type RulePlan = {
  description: string;
  pesos: number;
  category: string;
  from: AccountKey | null;
  to: AccountKey | null;
  frequency: "weekly" | "monthly" | "yearly";
  intervalN: number;
  dayOfMonth: number | null;
  // Days from today. A past date makes the generator back-fill the periods the
  // rule missed, which is where the movements hanging off it come from.
  nextRunInDays: number;
  endsInDays?: number;
  paused?: boolean;
};

const DEMO_RULES: RulePlan[] = [
  {
    description: "Arriendo mensual",
    pesos: 1_350_000,
    category: "Arriendo",
    from: "savings",
    to: null,
    frequency: "monthly",
    intervalN: 1,
    dayOfMonth: 5,
    nextRunInDays: -62,
  },
  {
    description: "Mercado semanal",
    pesos: 140_000,
    category: "Mercado",
    from: "nequi",
    to: null,
    frequency: "weekly",
    intervalN: 1,
    dayOfMonth: null,
    nextRunInDays: -28,
  },
  {
    description: "Mensualidad del gimnasio",
    pesos: 110_000,
    category: "Gimnasio",
    from: "savings",
    to: null,
    frequency: "monthly",
    intervalN: 1,
    dayOfMonth: 15,
    nextRunInDays: 11,
    paused: true,
  },
  {
    description: "Cuota del curso de inglés",
    pesos: 150_000,
    category: "Cursos",
    from: "savings",
    to: null,
    frequency: "monthly",
    intervalN: 1,
    dayOfMonth: 20,
    nextRunInDays: 16,
    endsInDays: 150,
  },
];

// Generated movements left unreviewed, so the "sin revisar" badge has something
// to count (RF-31). The newest are the ones left standing.
const UNREVIEWED_KEPT = 3;

const PLAN_DESCRIPTION = "Nevera y lavadora";
const PLAN_INSTALLMENTS = 12;
const PLAN_PAID_LINES = 3;

/**
 * The tables the seed can write, and how a row of each is attributed to the
 * seeded user. The census is per user, not global: this database is shared with
 * the harness layers and the other tracks, and a global count moves under a run
 * that has nothing to do with the seed.
 *
 * `audit_log` is expected back to its starting count too: `drop` runs under
 * the seeded user's own claims and then purges the trail bounded to them, so
 * no delete here stamps a both-null row nothing can find again.
 */
const CENSUS_TABLES = {
  accounts: "select count(*) from accounts where owner_user_id = $1",
  categories: "select count(*) from categories where owner_user_id = $1",
  labels: "select count(*) from labels where owner_user_id = $1",
  transactions: "select count(*) from transactions where owner_user_id = $1",
  transaction_splits:
    "select count(*) from transaction_splits s join transactions t on t.id = s.transaction_id where t.owner_user_id = $1",
  transaction_labels:
    "select count(*) from transaction_labels tl join transactions t on t.id = tl.transaction_id where t.owner_user_id = $1",
  budgets: "select count(*) from budgets where owner_user_id = $1",
  savings_goals: "select count(*) from savings_goals where owner_user_id = $1",
  goal_contributions:
    "select count(*) from goal_contributions gc join savings_goals g on g.id = gc.goal_id where g.owner_user_id = $1",
  planned_payments: "select count(*) from planned_payments where owner_user_id = $1",
  recurring_rules: "select count(*) from recurring_rules where owner_user_id = $1",
  installment_plans:
    "select count(*) from installment_plans p join accounts a on a.id = p.account_id where a.owner_user_id = $1",
  installment_lines:
    "select count(*) from installment_lines l join installment_plans p on p.id = l.plan_id join accounts a on a.id = p.account_id where a.owner_user_id = $1",
  debt_terms:
    "select count(*) from debt_terms d join accounts a on a.id = d.account_id where a.owner_user_id = $1",
  account_statements:
    "select count(*) from account_statements s join accounts a on a.id = s.account_id where a.owner_user_id = $1",
  ingest_deliveries: "select count(*) from ingest_deliveries where owner_user_id = $1",
  audit_log: "select count(*) from audit_log where owner_user_id = $1",
} as const;

type CensusTable = keyof typeof CENSUS_TABLES;
type Census = Record<string, number>;

type Scaffold = {
  accountIds: Record<AccountKey, string>;
  categoryIdByName: Map<string, string>;
  labelIdByName: Map<string, string>;
};

function argument(name: string): string | undefined {
  const found = process.argv.find((one) => one.startsWith(`--${name}=`));

  return found?.slice(name.length + 3);
}

// A deterministic stream over the movement's own key, so two runs write the same
// ledger and a topped-up run writes what the first would have.
function noise(key: string): number {
  let hash = 2166136261;
  for (let at = 0; at < key.length; at += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(at), 16777619);
  }

  return Math.abs(hash % 100000);
}

// The recipe's amount, jittered by up to ±8% and rounded to the peso, so a month
// of movements does not read as the same figure repeated.
function amountFor(recipe: Recipe, day: string): number {
  const swing = (noise(`${recipe.slot}:${day}`) % 1601) - 800;
  const pesos = Math.round((recipe.pesos * (10000 + swing)) / 10000);

  return pesosToCents(pesos);
}

// The `YYYY-MM-01` of the month `n` months from today's.
function monthStart(n: number): string {
  return `${addCivilMonths(`${todayInBogota().slice(0, 7)}-01`, n).slice(0, 7)}-01`;
}

// The `day`-th of `month`, clamped to the month's length so a 29 lands on the
// last day of February rather than rolling into March.
function dayOfMonth(month: string, day: number): string {
  const lastDay = Number(addCivilDays(addCivilMonths(month, 1), -1).slice(8));

  return `${month.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

// The split rows a recipe's weights come to, the remainder landing on the last so
// the set sums to the movement's amount exactly, as the trigger requires (RF-69).
function splitsFor(
  recipe: Recipe,
  amountCents: number,
  scaffold: Scaffold,
): { categoryId: string; amountCents: number }[] {
  if (recipe.splits === undefined) return [];

  const total = recipe.splits.reduce((sum, split) => sum + split.weight, 0);
  let left = amountCents;

  return recipe.splits.map((split, index) => {
    const share =
      index === recipe.splits!.length - 1
        ? left
        : Math.floor((amountCents * split.weight) / total);
    left -= share;

    return { categoryId: categoryId(scaffold, split.category), amountCents: share };
  });
}

function categoryId(scaffold: Scaffold, name: string): string {
  const id = scaffold.categoryIdByName.get(name);
  if (id === undefined) throw new Error(`no category named "${name}" for this user`);

  return id;
}

/**
 * Every movement of the ten-month window, oldest first. A recipe fires once per
 * named day of every month it belongs to; anything dated past today is dropped,
 * so the current month carries the days it has actually had.
 */
function plannedMovements(scaffold: Scaffold): CreateTransactionArgs[] {
  const today = todayInBogota();
  const planned: CreateTransactionArgs[] = [];

  for (let back = MONTHS_BACK; back >= 0; back -= 1) {
    const month = monthStart(-back);

    for (const recipe of RECIPES) {
      const every = recipe.everyNMonths ?? 1;
      if (back % every !== (recipe.phase ?? 0) % every) continue;

      for (const day of recipe.days) {
        const occurredAt = dayOfMonth(month, day);
        if (occurredAt > today) continue;

        const amountCents = amountFor(recipe, occurredAt);
        const labelId = recipe.label
          ? scaffold.labelIdByName.get(recipe.label)
          : undefined;

        planned.push({
          fromAccountId: recipe.from ? scaffold.accountIds[recipe.from] : null,
          toAccountId: recipe.to ? scaffold.accountIds[recipe.to] : null,
          amountCents,
          occurredAt,
          description: recipe.description,
          externalRef: `${SEED_PREFIX}${occurredAt}:${recipe.slot}-${day}`,
          splits: splitsFor(recipe, amountCents, scaffold),
          labelIds: labelId ? [labelId] : [],
        });
      }
    }
  }

  return planned;
}

// One round trip for the whole census: every count unioned, each subquery reading
// the same user id. Built with `unsafe` because a count is a whole statement, not
// a value; every fragment comes from the constant above and none from an argument.
async function census(userId: string): Promise<Census> {
  const rows = await fixtureSql.unsafe<{ name: string; total: string }[]>(
    tables()
      .map((table) => `select '${table}' as name, (${CENSUS_TABLES[table]})::text as total`)
      .join(" union all "),
    [userId],
  );

  return Object.fromEntries(rows.map((row) => [row.name, Number(row.total)]));
}

function tables(): CensusTable[] {
  return Object.keys(CENSUS_TABLES) as CensusTable[];
}

function printCensus(when: string, counts: Census): void {
  console.log(
    `CENSUS  ${when}: ${tables()
      .map((table) => `${table} ${counts[table]}`)
      .join(", ")}`,
  );
}

// The difference the run left, table by table. A drop that reports "every
// table unchanged" is a drop that took back exactly what the seed wrote.
function printDelta(before: Census, after: Census): void {
  const moved = tables()
    .filter((table) => after[table] !== before[table])
    .map((table) => {
      const delta = after[table] - before[table];
      return `${table} ${delta > 0 ? "+" : ""}${delta}`;
    });

  console.log(
    `CENSUS  delta: ${moved.length === 0 ? "every table unchanged" : moved.join(", ")}`,
  );
}

async function resolveUser(email: string): Promise<HarnessUser> {
  const user = await findUserByEmail(email);

  if (!user) throw new Error(`no auth user for ${email} — pass --email=`);

  return user;
}

/**
 * The accounts, subcategories and labels everything else hangs off, created on
 * the first run and found again by name on every later one. Written through
 * `createAccount`, `createCategory` and `createLabel`, so the rows carry what the
 * screens write.
 */
async function ensureScaffold(userId: string): Promise<Scaffold> {
  const [accounts, categories, labels] = await Promise.all([
    listAccounts({ archived: false }),
    listScopedCategories(userId),
    listLabels({ ownerUserId: userId }),
  ]);

  const accountIdByName = new Map(accounts.map((account) => [account.name, account.id]));
  const categoryIdByName = new Map<string, string>();
  for (const parent of categories) {
    categoryIdByName.set(parent.name, parent.id);
    for (const child of parent.children) categoryIdByName.set(child.name, child.id);
  }
  const labelIdByName = new Map(labels.map((label) => [label.name, label.id]));

  // A day before the oldest movement, so the opening balance never sits inside
  // the window the ledger derives over.
  const balanceOn = addCivilDays(monthStart(-MONTHS_BACK), -1);
  const accountIds = {} as Record<AccountKey, string>;

  for (const account of DEMO_ACCOUNTS) {
    const already = accountIdByName.get(account.name);
    if (already) {
      accountIds[account.key] = already;
      continue;
    }

    const { accountId } = await createAccount({
      name: account.name,
      kind: account.kind,
      subtype: account.subtype,
      ownerUserId: userId,
      groupId: null,
      isShared: false,
      institution: account.institution,
      lastFour: account.lastFour,
      settlementCurrency: account.settlementCurrency,
      // The stored scale is ×100 of the major unit for every currency alike
      // (RNF-05), the same conversion `pesosToCents` already does for a peso.
      amountMinor: pesosToCents(account.openingAmount),
      balanceOn,
    });

    accountIds[account.key] = accountId;
  }

  for (const subcategory of DEMO_SUBCATEGORIES) {
    if (categoryIdByName.has(subcategory.name)) continue;

    const { categoryId: id } = await createCategory({
      scope: { ownerUserId: userId },
      name: subcategory.name,
      kind: "expense",
      parentId: categoryIdByName.get(subcategory.parent) ?? null,
      // A subcategory takes its parent's colour inside the insert.
      color: null,
    });

    categoryIdByName.set(subcategory.name, id);
  }

  for (const label of DEMO_LABELS) {
    if (labelIdByName.has(label.name)) continue;

    const { labelId } = await createLabel({
      scope: { ownerUserId: userId },
      name: label.name,
      color: label.color,
    });

    labelIdByName.set(label.name, labelId);
  }

  return { accountIds, categoryIdByName, labelIdByName };
}

async function seededRefs(userId: string): Promise<Set<string>> {
  const rows = await fixtureSql<{ external_ref: string }[]>`
    select external_ref from transactions
    where owner_user_id = ${userId} and external_ref like ${`${SEED_PREFIX}%`}`;

  return new Set(rows.map((row) => row.external_ref));
}

// The ledger, written in waves of concurrent commits: every movement the plan
// names that is not already in place, in the order the plan holds them.
async function seedMovements(userId: string, scaffold: Scaffold): Promise<void> {
  const planned = plannedMovements(scaffold);
  const already = await seededRefs(userId);
  const missing = planned.filter((movement) => !already.has(movement.externalRef!));

  console.log(
    `SEED    ${planned.length - missing.length} of ${planned.length} movements are already in place; writing ${missing.length}.`,
  );
  if (missing.length === 0) return;

  const started = Date.now();
  const writeBatch = (batch: CreateTransactionArgs[]) =>
    withUserDb(async (tx) => {
      for (const movement of batch) await insertTransaction(tx, movement);
    });

  const stride = BATCH * PARALLEL;
  for (let at = 0; at < missing.length; at += stride) {
    const wave = missing.slice(at, at + stride);
    const batches: CreateTransactionArgs[][] = [];
    for (let cut = 0; cut < wave.length; cut += BATCH) {
      batches.push(wave.slice(cut, cut + BATCH));
    }

    await Promise.all(batches.map(writeBatch));
    console.log(`SEED    ${Math.min(at + stride, missing.length)} of ${missing.length} movements written.`);
  }

  console.log(`SEED    ${missing.length} movements written in ${Date.now() - started} ms.`);
}

/**
 * The four rules, then the movements they owe. The generator is the app's own
 * back-fill (RF-30) and runs for every rule that is due, so a rule of another
 * track's would be generated too — the count of foreign due rules is reported
 * before it runs. What it writes lands unreviewed; all but the newest few are
 * stamped, which is what leaves the "sin revisar" badge with something to count.
 */
async function seedRecurring(scaffold: Scaffold): Promise<void> {
  const today = todayInBogota();
  const existing = new Map(
    (await listRecurringRules()).map((rule) => [rule.description, rule.id]),
  );

  for (const plan of DEMO_RULES) {
    if (existing.has(plan.description)) continue;

    const { recurringRuleId } = await createRecurringRule({
      fromAccountId: plan.from ? scaffold.accountIds[plan.from] : null,
      toAccountId: plan.to ? scaffold.accountIds[plan.to] : null,
      amountCents: pesosToCents(plan.pesos),
      categoryId: categoryId(scaffold, plan.category),
      description: plan.description,
      frequency: plan.frequency,
      intervalN: plan.intervalN,
      dayOfMonth: plan.dayOfMonth,
      nextRunOn: addCivilDays(today, plan.nextRunInDays),
      endsOn: plan.endsInDays ? addCivilDays(today, plan.endsInDays) : null,
    });

    if (plan.paused) await setRecurringRuleActive({ id: recurringRuleId, isActive: false });
  }

  // Scoped to the seed's own author: the sweep used to run over every due rule
  // in the database, so a seed wrote movements into other people's ledgers. The
  // daily cron still calls it with no argument, which is what the cron is for.
  await fixtureSql`
    select private.run_due_recurring_rules(${process.env.HARNESS_USER_ID!}::uuid)`;

  const unreviewed = await listTransactions({ unreviewed: true });
  for (const movement of unreviewed.slice(UNREVIEWED_KEPT)) {
    await markTransactionReviewed({ transactionId: movement.id });
  }

  console.log(
    `SEED    ${unreviewed.length} generated movements in hand, ${Math.min(unreviewed.length, UNREVIEWED_KEPT)} left unreviewed.`,
  );
}

// The five planned payments and their three ends: two still ahead, one already
// past its date, one settled into a real movement and one cancelled (RF-74, RF-75).
async function seedPayments(scaffold: Scaffold): Promise<void> {
  const today = todayInBogota();
  const existing = new Set(
    (await listPlannedPayments()).map((payment) => payment.description),
  );

  for (const plan of DEMO_PAYMENTS) {
    if (existing.has(plan.description)) continue;

    const dueDate = addCivilDays(today, plan.dueInDays);
    const amountCents = pesosToCents(plan.pesos);
    const fromAccountId = scaffold.accountIds[plan.from];
    const category = categoryId(scaffold, plan.category);

    const { plannedPaymentId } = await createPlannedPayment({
      fromAccountId,
      toAccountId: null,
      amountCents,
      categoryId: category,
      dueDate,
      remindOn: addCivilDays(dueDate, -3),
      description: plan.description,
    });

    if (plan.outcome === "settled") {
      await settlePlannedPayment({
        plannedPaymentId,
        fromAccountId,
        toAccountId: null,
        amountCents,
        categoryId: category,
        occurredAt: dueDate,
        description: plan.description,
      });
    }

    if (plan.outcome === "cancelled") {
      await cancelPlannedPayment({ plannedPaymentId });
    }
  }
}

// One purchase in dollars on the Falabella card, which settles in pesos
// (RF-121, RF-123). `copBilledCents` absent leaves the estimate a person typed
// standing; present, `recordBilledAmount` replaces it with what the issuer
// billed, the same write the card's screen calls. Every amount is already in
// the stored scale — hundredths of its own currency's major unit — so no float
// crosses into a column here.
type ForeignPurchase = {
  slot: string;
  daysAgo: number;
  usdCents: number;
  copEstimateCents: number;
  copBilledCents?: number;
  description: string;
  category: string;
};

const FOREIGN_PURCHASES: ForeignPurchase[] = [
  {
    slot: "spotify",
    daysAgo: 96,
    usdCents: 1199,
    copEstimateCents: pesosToCents(48_000),
    copBilledCents: pesosToCents(47_640),
    description: "Spotify Premium",
    category: "Suscripciones",
  },
  {
    slot: "amazon",
    daysAgo: 63,
    usdCents: 6250,
    copEstimateCents: pesosToCents(250_000),
    copBilledCents: pesosToCents(248_800),
    description: "Compra en Amazon",
    category: "Ocio",
  },
  {
    slot: "netflix",
    daysAgo: 18,
    usdCents: 1549,
    copEstimateCents: pesosToCents(62_000),
    description: "Netflix",
    category: "Suscripciones",
  },
  {
    slot: "steam",
    daysAgo: 6,
    usdCents: 3999,
    copEstimateCents: pesosToCents(160_000),
    description: "Compra en Steam",
    category: "Ocio",
  },
];

// One exchange between the peso and the dollar account (RF-122): booked in
// pesos, the side that pays, with the dollar side confirmed at the same
// moment — a transfer carries no estimate, which is RF-123's alone to wait on.
const CURRENCY_TRANSFER_COP_CENTS = pesosToCents(2_000_000);
const CURRENCY_TRANSFER_USD_CENTS = 50_000;

/**
 * The Falabella card's dollar purchases and the one exchange into the Payoneer
 * account, written through `createTransaction` and `recordBilledAmount` — the
 * same paths the movement form and the card's screen call. Every external_ref
 * is checked against the same set `seedMovements` reads, so a second run bills
 * nothing twice and writes no purchase or transfer again.
 */
async function seedForeignCurrency(userId: string, scaffold: Scaffold): Promise<void> {
  const falabella = scaffold.accountIds.falabella;
  const already = await seededRefs(userId);

  for (const purchase of FOREIGN_PURCHASES) {
    const externalRef = `${SEED_PREFIX}usd:${purchase.slot}`;
    if (already.has(externalRef)) continue;

    const { transactionId } = await createTransaction({
      fromAccountId: falabella,
      toAccountId: null,
      amountCents: purchase.usdCents,
      currency: "USD",
      counterAmountCents: purchase.copEstimateCents,
      counterIsEstimate: true,
      occurredAt: addCivilDays(todayInBogota(), -purchase.daysAgo),
      description: purchase.description,
      externalRef,
      splits: [
        { categoryId: categoryId(scaffold, purchase.category), amountCents: purchase.usdCents },
      ],
      labelIds: [],
    });

    if (purchase.copBilledCents === undefined) continue;

    await recordBilledAmount({
      transactionId,
      accountId: falabella,
      currency: BASE_CURRENCY,
      billedCents: purchase.copBilledCents,
    });
  }

  const transferRef = `${SEED_PREFIX}usd:transfer`;
  if (!already.has(transferRef)) {
    await createTransaction({
      fromAccountId: scaffold.accountIds.savings,
      toAccountId: scaffold.accountIds.usd,
      amountCents: CURRENCY_TRANSFER_COP_CENTS,
      currency: BASE_CURRENCY,
      counterAmountCents: CURRENCY_TRANSFER_USD_CENTS,
      occurredAt: addCivilDays(todayInBogota(), -20),
      description: "Compra de dólares",
      externalRef: transferRef,
      splits: [],
      labelIds: [],
    });
  }
}

/**
 * The two debts: the Visa carries the terms (RF-78) and no statement history —
 * a close is recorded off a real statement, never generated (RF-129) — and the
 * Falabella carries a twelve-line plan whose first lines are already paid
 * (RF-81, RF-82). The payment is written only while no line is paid, so a second
 * run never walks the FIFO on further.
 */
async function seedDebts(scaffold: Scaffold): Promise<void> {
  const today = todayInBogota();

  await upsertDebtTerms({
    accountId: scaffold.accountIds.visa,
    debtKind: "revolving",
    annualRate: "0.2850",
    minimumPaymentCents: null,
    minimumPaymentPct: "0.05",
    creditLimitCents: pesosToCents(8_000_000),
    statementCutOffDay: 15,
    paymentDueDay: 5,
    avalCents: null,
  });

  const falabella = scaffold.accountIds.falabella;
  const plans = await listPlansForAccount(falabella);
  if (plans.length === 0) {
    const startDate = dayOfMonth(monthStart(-3), 10);
    const principalCents = pesosToCents(3_600_000);
    const perLine = Math.floor(principalCents / PLAN_INSTALLMENTS);

    await createInstallmentPlan({
      accountId: falabella,
      description: PLAN_DESCRIPTION,
      principalCents,
      nInstallments: PLAN_INSTALLMENTS,
      frequency: "monthly",
      interestRate: "0.0195",
      downPaymentCents: null,
      avalCents: null,
      startDate,
      merchant: "Falabella",
      lines: Array.from({ length: PLAN_INSTALLMENTS }, (_, index) => ({
        seq: index + 1,
        dueDate: addCivilMonths(startDate, index),
        // The rounding remainder rides the last line, so the lines sum to the principal.
        amountCents:
          index === PLAN_INSTALLMENTS - 1
            ? principalCents - perLine * (PLAN_INSTALLMENTS - 1)
            : perLine,
      })),
    });
  }

  const [plan] = await listPlansForAccount(falabella);
  const paidAlready = plan.lines.some((line) => line.paidTransactionId !== null);
  if (!paidAlready) {
    const covered = plan.lines
      .slice(0, PLAN_PAID_LINES)
      .reduce((sum, line) => sum + line.amountCents, 0);

    const { paidLineIds } = await recordDebtPayment({
      fromAccountId: scaffold.accountIds.savings,
      toAccountId: falabella,
      amountCents: covered,
      occurredAt: addCivilDays(today, -35),
    });

    console.log(`SEED    ${paidLineIds.length} installment line(s) marked paid.`);
  }
}

// The four goals and their aportes. Each goal's aportes are written with it, so a
// second run — which finds the goal by name — never adds a second set.
async function seedGoals(userId: string, scaffold: Scaffold): Promise<void> {
  const today = todayInBogota();
  const [live, archived] = await Promise.all([
    listGoalsWithProgress(),
    listGoalsWithProgress({ archived: true }),
  ]);
  const existing = new Set([...live, ...archived].map((goal) => goal.name));

  for (const plan of DEMO_GOALS) {
    if (existing.has(plan.name)) continue;

    const { goalId } = await createGoal({
      ownerUserId: userId,
      groupId: null,
      name: plan.name,
      targetAmountCents: pesosToCents(plan.targetPesos),
      targetDate:
        plan.targetMonths === null ? null : addCivilMonths(today, plan.targetMonths),
      accountId: plan.account ? scaffold.accountIds[plan.account] : null,
    });

    for (const pesos of plan.contributionsPesos) {
      await addGoalContribution({ goalId, amountCents: pesosToCents(pesos) });
    }

    if (plan.archived) await archiveGoal({ goalId });
  }
}

/**
 * The six budgets, then their limits. A limit is derived from what the window has
 * actually spent rather than fixed here: the roomy one keeps its room, one lands
 * over its threshold and one over its limit, whatever the ledger came to — and a
 * re-run recomputes the same figures instead of drifting.
 */
async function seedBudgets(userId: string, scaffold: Scaffold): Promise<void> {
  const [live, archived] = await Promise.all([
    listBudgetsWithStatus(),
    listBudgetsWithStatus(undefined, { archived: true }),
  ]);
  const existing = new Set([...live, ...archived].map((budget) => budget.name));

  for (const plan of DEMO_BUDGETS) {
    if (existing.has(plan.name)) continue;

    const { budgetId } = await createBudget({
      ownerUserId: userId,
      groupId: null,
      categoryId: categoryId(scaffold, plan.category),
      accountId: plan.account ? scaffold.accountIds[plan.account] : null,
      labelId: plan.label ? scaffold.labelIdByName.get(plan.label) ?? null : null,
      period: plan.period,
      // Provisional: the pass below sets the figure the spend calls for.
      limitCents: pesosToCents(EMPTY_BUDGET_LIMIT_PESOS),
      thresholdPct: plan.thresholdPct,
      name: plan.name,
    });

    if (plan.archived) await archiveBudget({ budgetId });
  }

  const [liveNow, archivedNow] = await Promise.all([
    listBudgetsWithStatus(),
    listBudgetsWithStatus(undefined, { archived: true }),
  ]);
  const statusByName = new Map(
    [...liveNow, ...archivedNow].map((budget) => [budget.name, budget]),
  );

  for (const plan of DEMO_BUDGETS) {
    const status = statusByName.get(plan.name);
    if (status === undefined) continue;

    // Cents throughout, and a whole number of pesos: COP has no coin under the
    // peso, so a limit is never left on a fraction of one. An empty window takes
    // the standing figure instead, since no spend names one.
    const derivedPesos = Math.round(
      (status.spentCents * 100) / plan.usedPct / 100,
    );
    const limitCents = pesosToCents(
      derivedPesos > 0 ? derivedPesos : EMPTY_BUDGET_LIMIT_PESOS,
    );
    if (limitCents === status.limitCents) continue;

    await updateBudget({
      budgetId: status.id,
      accountId: status.accountId,
      labelId: status.labelId,
      period: status.period,
      limitCents,
      thresholdPct: status.thresholdPct,
      name: status.name,
    });
  }
}

async function seed(user: HarnessUser): Promise<void> {
  const scaffold = await ensureScaffold(user.id);

  await seedMovements(user.id, scaffold);
  await seedForeignCurrency(user.id, scaffold);
  await seedRecurring(scaffold);
  await seedPayments(scaffold);
  await seedDebts(scaffold);
  await seedGoals(user.id, scaffold);
  // Last: every limit is derived from the movements every step above wrote.
  await seedBudgets(user.id, scaffold);
}

/**
 * Removes exactly what the seed wrote. The accounts it made anchor most of it —
 * every movement here touches one of them — and the rows that hang off no account
 * are named by the name they show on screen. The order is child before parent:
 * several of these foreign keys are ON DELETE RESTRICT.
 *
 * `ingest_deliveries` is absent on purpose: a delivery is reviewed or silenced,
 * never deleted, and no grant admits one.
 *
 * The deletes run under `asOwner` so `capture_audit` stamps every one of them
 * with the seeded user as actor, which is what makes the trail they cause
 * reachable by `purgeAuditTrail` next — otherwise the connection settles no
 * claims and the rows land both-null, unattributed and unfindable.
 */
async function drop(user: HarnessUser): Promise<void> {
  const accountNames = DEMO_ACCOUNTS.map((account) => account.name);
  const accounts = await fixtureSql<{ id: string }[]>`
    select id from accounts
    where owner_user_id = ${user.id} and name = any(${accountNames})`;
  const accountIds = accounts.map((account) => account.id);

  if (accountIds.length === 0) {
    console.log("DROP    no seeded account is left; nothing to take back.");
    return;
  }

  let budgets = 0;
  let payments = 0;
  let rules = 0;
  let goals = 0;
  let movements = 0;
  let labels = 0;
  let categories = 0;

  await asOwner(user.id, async (tx) => {
    ({ count: budgets } = await tx`
      delete from budgets
      where owner_user_id = ${user.id} and name = any(${DEMO_BUDGETS.map((one) => one.name)})`);

    ({ count: payments } = await tx`
      delete from planned_payments
      where owner_user_id = ${user.id}
        and (from_account_id = any(${accountIds}) or to_account_id = any(${accountIds}))`);

    ({ count: rules } = await tx`
      delete from recurring_rules
      where owner_user_id = ${user.id}
        and (from_account_id = any(${accountIds}) or to_account_id = any(${accountIds}))`);

    // The aportes cascade off the goal.
    ({ count: goals } = await tx`
      delete from savings_goals
      where owner_user_id = ${user.id} and name = any(${DEMO_GOALS.map((one) => one.name)})`);

    // The lines cascade off the plan.
    await tx`delete from installment_plans where account_id = any(${accountIds})`;
    await tx`delete from account_statements where account_id = any(${accountIds})`;
    await tx`delete from debt_terms where account_id = any(${accountIds})`;

    // The splits and the label joins cascade off the movement.
    ({ count: movements } = await tx`
      delete from transactions
      where owner_user_id = ${user.id}
        and (from_account_id = any(${accountIds}) or to_account_id = any(${accountIds}))`);

    ({ count: labels } = await tx`
      delete from labels
      where owner_user_id = ${user.id} and name = any(${DEMO_LABELS.map((one) => one.name)})`);

    ({ count: categories } = await tx`
      delete from categories
      where owner_user_id = ${user.id} and parent_id is not null
        and name = any(${DEMO_SUBCATEGORIES.map((one) => one.name)})`);

    await tx`delete from accounts where id = any(${accountIds})`;
  });

  await purgeAuditTrail([user.id]);

  console.log(
    `DROP    ${movements} movements, ${budgets} budgets, ${goals} goals, ${payments} payments, ${rules} rules, ${labels} labels, ${categories} subcategories and ${accountIds.length} accounts removed.`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "seed";
  if (!["seed", "drop", "count"].includes(command)) {
    throw new Error(`unknown command "${command}" — use seed, drop or count`);
  }

  const user = await resolveUser(argument("email") ?? DEMO_EMAIL);
  // Read by the Supabase stub, so every app function below speaks for this user
  // and meets RLS as it would in a request.
  process.env.HARNESS_USER_ID = user.id;
  process.env.HARNESS_USER_EMAIL = user.email;
  console.log(`SEED    ${command} for ${user.email} (${user.id}).`);

  const before = await census(user.id);
  printCensus("before", before);

  if (command === "seed") await seed(user);
  if (command === "drop") await drop(user);

  const after = await census(user.id);
  printCensus("after", after);
  printDelta(before, after);
}

// Wrapped in an async IIFE (not top-level await) so the runner can transpile this
// to CJS and run it on any Node version, not only Node 22's native strip.
void (async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await fixtureSql.end();
  }

  // The app pool holds its sockets for `idle_timeout` seconds after the last
  // query, which would keep this process alive with nothing left to do.
  process.exit(process.exitCode ?? 0);
})();
