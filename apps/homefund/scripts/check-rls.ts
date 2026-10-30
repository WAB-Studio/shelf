// Proves the access policies actually fire. Runs outside Next.js under Node 22
// type stripping, so it reads `process.env` directly and pulls only
// `pgErrorCode` from the app.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getTableColumns, is, sql as dsql } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { settleSessionSql } from "@repo/supabase-auth/settle";

import {
  applicationName,
  closeRun,
  openRun,
  registerEphemeralIdentity,
  runId,
} from "@repo/harness-registry";

import { insertRow } from "@/db/insert-row";
import type { InsertValues } from "@/db/insert-row";
// The two report functions this file drives instead of replicating; both open
// their own `withUserDb` over the app pool, which is why their fixtures commit.
import { listBudgetsWithStatus } from "@/db/queries/budgets";
import { commitImport } from "@/db/queries/import-commit";
import type { CommitInput, CommitScope } from "@/db/queries/import-commit";
import { getSixMonthFlow } from "@/db/queries/reports/monthly-flow";
import * as schema from "@/db/schema";
import { todayInBogota } from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-error";
import { CATEGORY_COLORS } from "@/lib/fund/category-color";
import { GROUP_CASH_ACCOUNT_NAME } from "@/lib/fund/seed";
import { REVIEW_RULES } from "@/lib/month-review-rules";

// `application_name` names the suite and the lane in `pg_stat_activity`; Supabase's
// pooler overwrites it to `Supavisor` on both endpoints (`docs/TRAPS.md`), so this
// is set on faith, never read back.
const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { application_name: applicationName("rls"), search_path: "finances, public" },
});

// The import commit writes through Drizzle, so the proof drives it through a Drizzle
// transaction over the same pool. `commitImport` takes the transaction and settles the
// session the way `withUserDb` does, so RLS decides every row here too.
const orm = drizzle(sql, { schema, casing: "snake_case" });

let failed = false;

function assert(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

// Mirrors `withUserDb`: claims first, then the role switch, both transaction-local.
// Idempotent — calling it again mid-transaction re-points `auth.uid()` at a new subject.
async function enterUserContext(
  tx: postgres.TransactionSql,
  subject: string,
  email?: string,
): Promise<void> {
  const claims = JSON.stringify({
    sub: subject,
    role: "authenticated",
    aud: "authenticated",
    // `auth.email()` reads this claim; the invite-claim policy matches it against `invite_email`.
    ...(email ? { email } : {}),
  });
  await tx`select
    set_config('request.jwt.claims', ${claims}, true),
    set_config('statement_timeout', '8000', true),
    set_config('role', 'authenticated', true)`;
}

async function main() {
  await openRun("rls", sql);

  const subject = randomUUID();
  const intruder = randomUUID();

  const [relOutside] = await sql<{ rowsecurity: boolean; forced: boolean }[]>`
    select relrowsecurity as rowsecurity, relforcerowsecurity as forced
    from pg_class where oid = 'finances.app_users'::regclass`;

  assert(
    "1. row security enabled",
    relOutside.rowsecurity === true,
    `pg_class.relrowsecurity = ${relOutside.rowsecurity}`,
  );

  await sql.begin(async (tx) => {
    await enterUserContext(tx, subject);

    const [{ current_user: currentUser }] = await tx<
      { current_user: string }[]
    >`select current_user`;
    assert(
      "2. role switch took effect",
      currentUser === "authenticated",
      `current_user = ${currentUser}`,
    );

    const [{ rolbypassrls }] = await tx<{ rolbypassrls: boolean }[]>`
      select rolbypassrls from pg_roles where rolname = current_user`;
    const [{ uid }] = await tx<{ uid: string | null }[]>`select auth.uid() as uid`;
    assert(
      "3. current role cannot bypass and carries the injected identity",
      rolbypassrls === false && uid === subject,
      `rolbypassrls = ${rolbypassrls}, auth.uid() = ${uid}`,
    );

    const [{ count }] = await tx<{ count: string }[]>`
      select count(*)::text as count from app_users`;
    assert(
      "4. select sees no other user's row",
      count === "0",
      `visible rows = ${count}`,
    );
  });

  await sql
    .begin(async (tx) => {
      await enterUserContext(tx, subject);
      await tx`insert into app_users (id) values (${intruder})`;
      assert(
        "5. insert for another id rejected",
        false,
        "the insert succeeded, which it must not",
      );
    })
    .catch((error: unknown) => {
      // 42501 = policy violation, 23503 = foreign key; either proves the write is barred.
      const code = (error as { code?: string }).code;
      assert(
        "5. insert for another id rejected",
        code === "42501" || code === "23503",
        `sqlstate ${code ?? "none"}`,
      );
    });

  const [{ current_user: afterUser }] = await sql<
    { current_user: string }[]
  >`select current_user`;
  assert(
    "6. role unwound with the transaction",
    afterUser === "postgres",
    `current_user = ${afterUser}`,
  );

  assert(
    "7. row security forced on the owner",
    relOutside.forced === true,
    `pg_class.relforcerowsecurity = ${relOutside.forced}`,
  );

  const [{ rolbypassrls: ownerBypasses }] = await sql<
    { rolbypassrls: boolean }[]
  >`select rolbypassrls from pg_roles where rolname = 'postgres'`;
  const [{ count: ownerCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from app_users`;

  console.log("");
  console.log(
    `REPORT  postgres.rolbypassrls = ${ownerBypasses} — ` +
      (ownerBypasses
        ? "the owner sees every row, FORCE buys nothing, and the role switch is the sole guarantee."
        : "FORCE is live and the owner is subject to the policies too."),
  );
  console.log(
    `REPORT  rows visible to postgres outside any role switch = ${ownerCount}.`,
  );
  console.log(
    "REPORT  assertion 4 alone is worthless against an empty table; 2, 3 and 7 are what give it teeth.",
  );

  if (process.env.RLS_ONLY === "m11") {
    await checkAccountSubtypeWords();
    return;
  }

  if (process.env.RLS_ONLY === "m1") {
    await checkAllowedEmailList();
    return;
  }

  if (process.env.RLS_ONLY === "m8") {
    await checkCategoryParentScope();
    await checkSubcategoryFollowsParent();
    return;
  }

  if (process.env.RLS_ONLY === "d64") {
    await checkInvitationAcceptance();
    return;
  }

  if (process.env.RLS_ONLY === "d67") {
    await checkPendingInvitationRead();
    return;
  }

  if (process.env.RLS_ONLY === "m82") {
    await checkLeaderGuardAndInvitationPredicates();
    return;
  }

  if (process.env.RLS_ONLY === "o5m2") {
    await checkO5M2Survivors();
    return;
  }

  if (process.env.RLS_ONLY === "o6m1") {
    await checkSettlingMovementDelete();
    return;
  }

  if (process.env.RLS_ONLY === "o6m1b") {
    await checkReturnKeepsScope();
    return;
  }

  if (process.env.RLS_ONLY === "o6m6") {
    await checkMovementBeforeOpening();
    return;
  }

  if (process.env.RLS_ONLY === "o7m11") {
    await checkO7M11Survivors();
    return;
  }

  if (process.env.RLS_ONLY === "o7m2") {
    await checkTransactionReviews();
    return;
  }

  if (process.env.RLS_ONLY === "c6c") {
    await checkMemberAddress();
    return;
  }

  await checkRepivotPolicies();
  await checkLedgerPolicies();
  await checkAnalyticsAggregates();
  await checkBudgetPolicies();
  await checkPlannedPaymentPolicies();
  await checkSavingsGoalPolicies();
  await checkDebtTermsPolicies();
  await checkInstallmentPolicies();
  await checkDebtDerivedFigures();
  await checkAccountStatementPolicies();
  await checkWebhookCredentialPolicies();
  await checkImpersonationBounds();
  await checkInviteClaimPolicies();
  await checkRecurringRulePolicies();
  await checkAuditLogPolicies();
  await checkAuditViewerPolicy();
  await checkAccountSubtypeBackfill();
  await checkCashReportInvariants();
  await checkExternalRefKeys();
  await checkImportCommit();
  await checkLabelPolicies();
  await checkWebhookCredentialOwnerWrites();
  await checkIngestDeliveryPolicies();
  await checkIngestMerchantTrust();
  await checkInsertGrantMap();
  await checkInsertHelper();
  await checkGroupMemberUserIdLock();
  await checkMemberManagementLeaderOnly();
  await checkDefaultPrivileges();
  await checkSlippedGrants();
  await checkGroupUpdatePolicy();
  await checkWriteGrantMap();
  await checkSelfTransferRefused();
  await checkCategoryParentScope();
  await checkSubcategoryFollowsParent();
  await checkGroupCommitsWithLeader();
  await checkInstallmentAllocation();
  await checkGoalAccountScope();
  await checkIngestShapeRestore();
  await checkReportFunctionsExcludeTransfers();
  await checkGroupSettingsWrite();
  await checkArchivePolicies();
  await checkContributionStamp();
  await checkGroupCategoryLeaderOnly();
  await checkLeadershipTransfer();
  await checkAccountHandOver();
  await checkCurrencyPolicies();
  await checkCounterAmountWriteScope();
  await checkRecurringRuleGeneratorScope();
  await checkAccountStatementShape();
  await checkAccountReconciliations();
  await checkRecurringRuleIsolation();
  await checkSharedToggleLeaderOnly();
  await checkCategoryExistsProbe();
  await checkAllowedEmailList();
  await checkAllowedEmailAudit();
  await checkAccountSubtypeWords();
  await checkMemberAddress();
  await checkRecurringPauseReason();
  await checkInvitationAcceptance();
  await checkPendingInvitationRead();
  await checkLeaderGuardAndInvitationPredicates();
  await checkO5M2Survivors();
  await checkSettlingMovementDelete();
  await checkReturnKeepsScope();
  await checkMovementBeforeOpening();
  await checkO7M11Survivors();
  await checkTransactionReviews();
}

// Assertions 9-26: the repivoted schema. A group holds accounts and categories a user XOR a group
// owns; read is universal inside the group, write is bounded to own-or-shared, and the leader
// manages the group's own categories. Fixtures are seeded through the app's own policies and rolled back.
async function checkRepivotPolicies() {
  console.log("");
  // Two fresh identities the section seeds itself, so it runs on an empty dev DB with no prior sign-in.
  // Both `auth.users` and `app_users` rows are inserted as the owner inside the transaction below and
  // roll back with it. Neither holds a live membership, so the one-group-per-user index leaves the
  // leader claim free to land.
  const leaderUser = randomUUID();
  const memberUser = randomUUID();

  const soloLabels = [
    "9. an account with both an owner and a group is refused",
    "10. an account with neither an owner nor a group is refused",
    "11. a personal account marked shared is refused",
    "12. a group whose cash_mode is neither value is refused",
    "13. a second live membership for a claimed user is refused",
    "14. a category with both an owner and a group is refused",
    "15. a category with neither an owner nor a group is refused",
    "16. deleting the sole leader while the group survives is refused",
  ];
  const pairLabels = [
    "17. a member reads another member's personal account",
    "18. a member cannot mint an account owned by another user",
    "19. a member's update and delete of another's personal account touch nothing",
    "20. a member writes their own account and the shared group account",
    "21. the leader reads a member's personal account",
    "22. the leader's update and delete of that account touch nothing",
    "23. a member reads a group category and the leader a member's personal one",
    "24. a personal category yields to its owner and to no one else",
    "25. a group category yields to the leader and to no plain member",
  ];
  const tailLabel = "26. the rolled-back transaction leaves no trace";

  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      // Seed the two base identities as the owner before any role switch: `auth.users` is the FK target
      // for `app_users`, and both are needed before the app's own policies can seed group fixtures.
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser})`;

      await enterUserContext(tx, leaderUser);

      // The group, its leader, one personal account, one shared group account and one group category:
      // the id is supplied client-side because an unclaimed group fails its own SELECT policy.
      await tx`insert into groups (id, name, cash_mode)
        values (${groupId}, 'rls repivot', 'shared')`;
      const [{ id: leaderMembership }] = await tx<{ id: string }[]>`
        insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls repivot leader', 'leader') returning id`;
      const [{ id: leaderAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls repivot leader cash', 'asset',
          (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: sharedAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${groupId}, true, 'rls repivot shared cash', 'asset',
          (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: groupCategory }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${groupId}, 'rls repivot group category', 'expense') returning id`;

      // 9-11: the accounts check constraints. Each row is otherwise writable, so only the CHECK can reject it.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into accounts (owner_user_id, group_id, name, kind, initial_balance_on)
            values (${leaderUser}, ${groupId}, 'rls repivot both', 'asset',
              (now() at time zone 'America/Bogota')::date)`;
          assert(soloLabels[0], false, "both an owner and a group landed, which it must not");
        })
        .catch((error: unknown) => {
          assert(soloLabels[0], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      await tx
        .savepoint(async (sp) => {
          await sp`insert into accounts (name, kind, initial_balance_on)
            values ('rls repivot neither', 'asset', (now() at time zone 'America/Bogota')::date)`;
          assert(soloLabels[1], false, "neither an owner nor a group landed, which it must not");
        })
        .catch((error: unknown) => {
          // 42501 = the INSERT WITH CHECK fires first, 23514 = the table CHECK; either bars the row.
          const code = pgErrorCode(error);
          assert(soloLabels[1], code === "42501" || code === "23514", `sqlstate ${code ?? "none"}`);
        });

      await tx
        .savepoint(async (sp) => {
          await sp`insert into accounts (owner_user_id, is_shared, name, kind, initial_balance_on)
            values (${leaderUser}, true, 'rls repivot personal shared', 'asset',
              (now() at time zone 'America/Bogota')::date)`;
          assert(soloLabels[2], false, "a shared personal account landed, which it must not");
        })
        .catch((error: unknown) => {
          assert(soloLabels[2], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 12: the cash_mode domain check on groups.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into groups (id, name, cash_mode)
            values (${randomUUID()}, 'rls repivot bad mode', 'weekly')`;
          assert(soloLabels[3], false, "an unknown cash_mode landed, which it must not");
        })
        .catch((error: unknown) => {
          assert(soloLabels[3], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 13: the one-group-per-user unique index. RLS admits the leader claim on a fresh group; the index refuses it.
      await tx
        .savepoint(async (sp) => {
          const secondGroup = randomUUID();
          await sp`insert into groups (id, name, cash_mode)
            values (${secondGroup}, 'rls repivot second group', 'shared')`;
          await sp`insert into group_members (group_id, user_id, name, role)
            values (${secondGroup}, ${leaderUser}, 'rls repivot double claim', 'leader')`;
          assert(soloLabels[4], false, "a second live membership landed, which it must not");
        })
        .catch((error: unknown) => {
          assert(soloLabels[4], pgErrorCode(error) === "23505", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 14-15: the categories owner-XOR-group check, both rows otherwise writable by the leader.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into categories (owner_user_id, group_id, name, kind)
            values (${leaderUser}, ${groupId}, 'rls repivot cat both', 'expense')`;
          assert(soloLabels[5], false, "both an owner and a group landed, which it must not");
        })
        .catch((error: unknown) => {
          assert(soloLabels[5], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      await tx
        .savepoint(async (sp) => {
          await sp`insert into categories (name, kind) values ('rls repivot cat neither', 'expense')`;
          assert(soloLabels[6], false, "neither an owner nor a group landed, which it must not");
        })
        .catch((error: unknown) => {
          // 42501 = the INSERT WITH CHECK fires first, 23514 = the table CHECK; either bars the row.
          const code = pgErrorCode(error);
          assert(soloLabels[6], code === "42501" || code === "23514", `sqlstate ${code ?? "none"}`);
        });

      // 16: the keep-leader guard. The write policies forbid dropping your own row, so this reaches past
      // them as `postgres`; `set constraints all immediate` forces the deferred trigger to fire now.
      await tx
        .savepoint(async (sp) => {
          await sp`reset role`;
          await sp`delete from group_members where id = ${leaderMembership}`;
          await sp`set constraints all immediate`;
          assert(soloLabels[7], false, "the group kept no leader and the delete stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(soloLabels[7], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });
      await enterUserContext(tx, leaderUser);

      // A second member with a login: no policy lets one member hand another their login, so seed it as `postgres`.
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls repivot member', 'member')`;

      await enterUserContext(tx, memberUser);
      const [{ id: memberAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${memberUser}, 'rls repivot member cash', 'asset',
          (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: memberCategory }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${memberUser}, 'rls repivot member category', 'expense') returning id`;

      // 17: universal read — a member sees another member's personal account through the group they share.
      const [{ count: memberSeesLeader }] = await tx<{ count: string }[]>`
        select count(*)::text as count from accounts where id = ${leaderAccount}`;
      assert(pairLabels[0], memberSeesLeader === "1", `visible rows = ${memberSeesLeader}`);

      // 18: the bounded write — a member may not mint an account owned by someone else.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into accounts (owner_user_id, name, kind, initial_balance_on)
            values (${leaderUser}, 'rls repivot forged', 'asset',
              (now() at time zone 'America/Bogota')::date)`;
          assert(pairLabels[1], false, "a member forged an account for the leader, which it must not");
        })
        .catch((error: unknown) => {
          assert(pairLabels[1], pgErrorCode(error) === "42501", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 19: the same bound on update and delete — the row is filtered out, so both commands touch nothing.
      const memberUpdate = await tx`update accounts set name = 'x' where id = ${leaderAccount}`;
      const memberDelete = await tx`delete from accounts where id = ${leaderAccount}`;
      assert(
        pairLabels[2],
        memberUpdate.count === 0 && memberDelete.count === 0,
        `update rows = ${memberUpdate.count}, delete rows = ${memberDelete.count}`,
      );

      // 20: what a member may write — their own account, and any account the group marked shared.
      const ownWrite = await tx`update accounts set name = 'rls repivot member cash, renamed'
        where id = ${memberAccount}`;
      const sharedWrite = await tx`update accounts set name = 'rls repivot shared cash, renamed'
        where id = ${sharedAccount}`;
      assert(
        pairLabels[3],
        ownWrite.count === 1 && sharedWrite.count === 1,
        `own rows = ${ownWrite.count}, shared rows = ${sharedWrite.count}`,
      );

      // 21-22: the leader reads a member's account but holds no write exception over it.
      await enterUserContext(tx, leaderUser);
      const [{ count: leaderSeesMember }] = await tx<{ count: string }[]>`
        select count(*)::text as count from accounts where id = ${memberAccount}`;
      assert(pairLabels[4], leaderSeesMember === "1", `visible rows = ${leaderSeesMember}`);
      const leaderUpdate = await tx`update accounts set name = 'x' where id = ${memberAccount}`;
      const leaderDelete = await tx`delete from accounts where id = ${memberAccount}`;
      assert(
        pairLabels[5],
        leaderUpdate.count === 0 && leaderDelete.count === 0,
        `update rows = ${leaderUpdate.count}, delete rows = ${leaderDelete.count}`,
      );

      // 23: universal read of categories, both directions — a member into the group's, the leader into a personal one.
      await enterUserContext(tx, memberUser);
      const [{ count: memberSeesGroupCat }] = await tx<{ count: string }[]>`
        select count(*)::text as count from categories where id = ${groupCategory}`;
      await enterUserContext(tx, leaderUser);
      const [{ count: leaderSeesMemberCat }] = await tx<{ count: string }[]>`
        select count(*)::text as count from categories where id = ${memberCategory}`;
      assert(
        pairLabels[6],
        memberSeesGroupCat === "1" && leaderSeesMemberCat === "1",
        `member→group = ${memberSeesGroupCat}, leader→personal = ${leaderSeesMemberCat}`,
      );

      // 24: a personal category bends to its owner, not to the leader of the group.
      const leaderOnMemberCat = await tx`update categories set name = 'x' where id = ${memberCategory}`;
      await enterUserContext(tx, memberUser);
      const ownerOnMemberCat = await tx`update categories set name = 'rls repivot member category, renamed'
        where id = ${memberCategory}`;
      assert(
        pairLabels[7],
        leaderOnMemberCat.count === 0 && ownerOnMemberCat.count === 1,
        `leader rows = ${leaderOnMemberCat.count}, owner rows = ${ownerOnMemberCat.count}`,
      );

      // 25: a group category bends to the leader, not to a plain member.
      const memberOnGroupCat = await tx`update categories set name = 'x' where id = ${groupCategory}`;
      await enterUserContext(tx, leaderUser);
      const leaderOnGroupCat = await tx`update categories set name = 'rls repivot group category, renamed'
        where id = ${groupCategory}`;
      assert(
        pairLabels[8],
        memberOnGroupCat.count === 0 && leaderOnGroupCat.count === 1,
        `member rows = ${memberOnGroupCat.count}, leader rows = ${leaderOnGroupCat.count}`,
      );

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterRepivotUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name = 'rls repivot'`;
  assert(
    tailLabel,
    afterRepivotUser === "postgres" && probeCount === "0",
    `current_user = ${afterRepivotUser}, rows named 'rls repivot' = ${probeCount}`,
  );
}

// Assertions 27-36: the ledger. A movement's scope and `kind` are the trigger's, not the caller's;
// write is bounded to own-or-shared accounts; income and expense carry splits that sum to the amount
// while a transfer carries none; and `account_balances` derives the balance from the movements.
// Every fixture is seeded through the app's own policies inside a transaction that rolls back.
async function checkLedgerPolicies() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const groupId = randomUUID();

  const labels = [
    "27. a writable movement inserts and holds the trigger's scope and kind, not the caller's",
    "28. a movement touching another member's personal account is refused",
    "29. kind follows the null pattern of from/to",
    "30. an income whose splits do not sum to its amount is refused at commit",
    "31. an income committed with no split is refused at commit",
    "32. a transfer carrying a split is refused",
    "33. a split whose category sits in another scope is refused",
    "34. a split whose category is of the wrong kind is refused",
    "35. a member reads a group movement and another member's personal movement",
    "36. account_balances returns the initial balance plus the net of movements, in the account's settlement currency",
  ];
  const tailLabel = "37. the rolled-back ledger transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");
  const kindRollback = Symbol("kind rollback");

  await sql
    .begin(async (tx) => {
      // Base identities and group, seeded as the owner before any role switch.
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser})`;

      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls ledger', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls ledger leader', 'leader')`;

      const [{ id: leaderAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls ledger leader cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: leaderAccountB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls ledger leader savings', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: sharedAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${groupId}, true, 'rls ledger shared cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: groupIncomeCat }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${groupId}, 'rls ledger group income', 'income') returning id`;

      // A second member with a login: seed the membership as the owner, no policy hands one out.
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls ledger member', 'member')`;

      await enterUserContext(tx, memberUser);
      const [{ id: memberAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${memberUser}, 'rls ledger member cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: balAccountA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${memberUser}, 'rls ledger balance A', 'asset', 100000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: balAccountB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${memberUser}, 'rls ledger balance B', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: memberIncomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${memberUser}, 'rls ledger member income', 'income') returning id`;
      const [{ id: memberExpenseCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${memberUser}, 'rls ledger member expense', 'expense') returning id`;

      // 27: a movement whose from/to are both writable inserts; the trigger, not the caller, owns
      // scope and kind. A transfer touching the shared account is group-scoped (group wins).
      await enterUserContext(tx, leaderUser);
      const [txnGroup] = await tx<
        { id: string; owner_user_id: string | null; group_id: string | null; kind: string; created_by: string }[]
      >`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${leaderAccount}, ${sharedAccount}, 5000, (now() at time zone 'America/Bogota')::date)
        returning id, owner_user_id, group_id, kind, created_by`;
      assert(
        labels[0],
        txnGroup.group_id === groupId &&
          txnGroup.owner_user_id === null &&
          txnGroup.kind === "transfer" &&
          txnGroup.created_by === leaderUser,
        `group_id = ${txnGroup.group_id}, owner = ${txnGroup.owner_user_id}, kind = ${txnGroup.kind}, created_by = ${txnGroup.created_by === leaderUser}`,
      );

      // A personal-scope movement of the leader, kept for the read test below.
      const [{ id: txnLeaderPersonal }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${leaderAccountB}, ${leaderAccount}, 2000, (now() at time zone 'America/Bogota')::date) returning id`;

      // 28: the bounded write — a member may not book a movement out of the leader's personal account.
      await enterUserContext(tx, memberUser);
      await tx
        .savepoint(async (sp) => {
          await sp`insert into transactions (from_account_id, amount_cents, occurred_at)
            values (${leaderAccount}, 5000, (now() at time zone 'America/Bogota')::date)`;
          assert(labels[1], false, "a member booked against the leader's account, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "42501", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 29: kind is generated from which side is null. Rolled back so its splitless rows never reach commit.
      const kinds: { income?: string; expense?: string; transfer?: string } = {};
      await tx
        .savepoint(async (sp) => {
          const [inc] = await sp<{ kind: string }[]>`insert into transactions (to_account_id, amount_cents, occurred_at)
            values (${memberAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning kind`;
          const [exp] = await sp<{ kind: string }[]>`insert into transactions (from_account_id, amount_cents, occurred_at)
            values (${memberAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning kind`;
          const [xfer] = await sp<{ kind: string }[]>`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
            values (${memberAccount}, ${balAccountA}, 5000, (now() at time zone 'America/Bogota')::date) returning kind`;
          kinds.income = inc.kind;
          kinds.expense = exp.kind;
          kinds.transfer = xfer.kind;
          throw kindRollback;
        })
        .catch((error: unknown) => {
          if (error !== kindRollback) throw error;
        });
      assert(
        labels[2],
        kinds.income === "income" && kinds.expense === "expense" && kinds.transfer === "transfer",
        `income = ${kinds.income}, expense = ${kinds.expense}, transfer = ${kinds.transfer}`,
      );

      // 30: the deferred sum check. The split matches scope and kind, so only the total can reject it,
      // and `set constraints all immediate` forces the deferred trigger to fire now.
      await tx
        .savepoint(async (sp) => {
          const [{ id: txn }] = await sp<{ id: string }[]>`
            insert into transactions (to_account_id, amount_cents, occurred_at)
            values (${memberAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;
          await sp`insert into transaction_splits (transaction_id, category_id, amount_cents)
            values (${txn}, ${memberIncomeCat}, 3000)`;
          await sp`set constraints all immediate`;
          assert(labels[3], false, "splits that miss the amount stood, which they must not");
        })
        .catch((error: unknown) => {
          assert(labels[3], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 31: an income with no split at all is equally refused at commit.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into transactions (to_account_id, amount_cents, occurred_at)
            values (${memberAccount}, 5000, (now() at time zone 'America/Bogota')::date)`;
          await sp`set constraints all immediate`;
          assert(labels[4], false, "a splitless income stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[4], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 32: a transfer names no category, so any split on it is rejected the moment it lands.
      await tx
        .savepoint(async (sp) => {
          const [{ id: txn }] = await sp<{ id: string }[]>`
            insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
            values (${memberAccount}, ${balAccountA}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;
          await sp`insert into transaction_splits (transaction_id, category_id, amount_cents)
            values (${txn}, ${memberExpenseCat}, 5000)`;
          assert(labels[5], false, "a transfer took a split, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[5], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 33-34: a split's category must share the movement's scope and kind. A group expense is the anchor.
      await enterUserContext(tx, leaderUser);
      await tx
        .savepoint(async (sp) => {
          const [{ id: txn }] = await sp<{ id: string }[]>`
            insert into transactions (from_account_id, amount_cents, occurred_at)
            values (${sharedAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;
          await sp`insert into transaction_splits (transaction_id, category_id, amount_cents)
            values (${txn}, ${memberExpenseCat}, 5000)`;
          assert(labels[6], false, "a foreign-scope split stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[6], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      await tx
        .savepoint(async (sp) => {
          const [{ id: txn }] = await sp<{ id: string }[]>`
            insert into transactions (from_account_id, amount_cents, occurred_at)
            values (${sharedAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;
          await sp`insert into transaction_splits (transaction_id, category_id, amount_cents)
            values (${txn}, ${groupIncomeCat}, 5000)`;
          assert(labels[7], false, "an income category on an expense stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[7], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 35: universal read — a member sees the group movement and the leader's personal one.
      await enterUserContext(tx, memberUser);
      const [{ count: seesGroup }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where id = ${txnGroup.id}`;
      const [{ count: seesPersonal }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where id = ${txnLeaderPersonal}`;
      assert(
        labels[8],
        seesGroup === "1" && seesPersonal === "1",
        `member→group = ${seesGroup}, member→leader personal = ${seesPersonal}`,
      );

      // 36: the derived balance is the opening figure plus what flowed in, less what flowed out.
      // The view keys on `(id, currency)`, so the row is named by its currency and never by `[0]`:
      // one account holds one pocket per currency it has touched, and only the settlement one answers
      // for the figure a person calls "the balance" (RF-121, RF-124).
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${balAccountB}, ${balAccountA}, 3000, (now() at time zone 'America/Bogota')::date)`;
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${balAccountA}, ${balAccountB}, 1000, (now() at time zone 'America/Bogota')::date)`;
      // A dollar spend still on estimate opens a second pocket on the same account, so the row the
      // assertion reads can only be found by naming a currency and never by taking the first one.
      const [{ id: balAbroad }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, currency, counter_amount_cents, counter_is_estimate)
        values (${balAccountA}, 500, (now() at time zone 'America/Bogota')::date, 'USD', 2000, true) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${balAbroad}, ${memberExpenseCat}, 500)`;
      const settlementBalance = await tx<{ balance_cents: string }[]>`
        select b.balance_cents
        from account_balances b
        join accounts a on a.id = b.id and a.settlement_currency = b.currency
        where b.id = ${balAccountA}`;
      const balance = settlementBalance[0]?.balance_cents;
      assert(
        labels[9],
        settlementBalance.length === 1 && balance === "102000",
        `settlement rows = ${settlementBalance.length}, balance_cents = ${balance}, expected 102000 (100000 + 3000 − 1000)`,
      );

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name = 'rls ledger'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls ledger' = ${probeCount}`,
  );
}

// Assertions 38-42: the analytics aggregates and the Phase 1 RLS that bounds them. No new policy
// ships — what is proved is query correctness under a member's context. The same window and the same
// aggregate SQL the report queries run are replicated inside the transaction, never the query functions
// themselves (they open their own `withUserDb`). Every fixture is seeded through the app's own policies
// and rolled back.
async function checkAnalyticsAggregates() {
  console.log("");
  const leaderUser = randomUUID();
  const secondLeader = randomUUID();
  const groupId = randomUUID();
  const secondGroup = randomUUID();

  const labels = [
    "38. the flow window sums the income and the expense, not the transfer — net is income − expense",
    "39. expense-by-category sums only the expense's splits; the transfer and income contribute no rows",
    "40. contribution netting credits a personal→group transfer and debits a group→personal return",
    "41. a second group's rows never enter the first member's flow or category aggregate",
    "42. a movement dated in the previous month is excluded from the current window",
  ];
  const tailLabel = "43. the rolled-back analytics transaction leaves no trace";

  // The exact aggregate SQL of the three report queries, replicated so the proof reads what ships.
  const flowSums = (q: postgres.TransactionSql, start: string, endExclusive: string) =>
    q<{ income_cents: string; expense_cents: string }[]>`
      select
        coalesce(sum(amount_cents) filter (where kind = 'income'), 0) as income_cents,
        coalesce(sum(amount_cents) filter (where kind = 'expense'), 0) as expense_cents
      from transactions
      where occurred_at >= ${start} and occurred_at < ${endExclusive}`;

  const categoryTotals = (q: postgres.TransactionSql, start: string, endExclusive: string) =>
    q<{ category_id: string; total_cents: string }[]>`
      select s.category_id, c.name, c.color, sum(s.amount_cents) as total_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join categories c on c.id = s.category_id
      where t.kind = 'expense'
        and t.occurred_at >= ${start} and t.occurred_at < ${endExclusive}
      group by s.category_id, c.name, c.color
      order by sum(s.amount_cents) desc`;

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      // Base identities and the caller's group, seeded as the owner before any role switch.
      await tx`insert into auth.users (id) values (${leaderUser}), (${secondLeader})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${secondLeader})`;

      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls analytics', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls analytics leader', 'leader')`;

      // Mirrors `currentMonthRange()`: the first of the current Bogotá month and the first of the next,
      // as YYYY-MM-DD strings — the very bounds the report queries receive.
      const [{ start: winStart, end_exclusive: winEnd }] = await tx<
        { start: string; end_exclusive: string }[]
      >`select
          to_char(date_trunc('month', now() at time zone 'America/Bogota'), 'YYYY-MM-DD') as start,
          to_char(date_trunc('month', now() at time zone 'America/Bogota') + interval '1 month', 'YYYY-MM-DD') as end_exclusive`;

      // The caller's personal account and the group's shared account: contribution flows between the two. The personal
      // one opens a month back, so the previous-month income below postdates its opening (RF-162).
      const [{ id: personalAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls analytics personal cash', 'asset', (date_trunc('month', now() at time zone 'America/Bogota') - interval '1 month')::date) returning id`;
      const [{ id: groupAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${groupId}, true, 'rls analytics group cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: incomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls analytics income', 'income') returning id`;
      const [{ id: expenseCatA }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls analytics rent', 'expense') returning id`;
      const [{ id: expenseCatB }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls analytics food', 'expense') returning id`;

      // One income (10000, single split), one expense (6000, split across two categories),
      // one contribution transfer (5000, personal→group) and its return (1500, group→personal).
      const [{ id: incomeTxn }] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at)
        values (${personalAccount}, 10000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${incomeTxn}, ${incomeCat}, 10000)`;

      const [{ id: expenseTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${personalAccount}, 6000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${expenseTxn}, ${expenseCatA}, 4000), (${expenseTxn}, ${expenseCatB}, 2000)`;

      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${personalAccount}, ${groupAccount}, 5000, (now() at time zone 'America/Bogota')::date)`;
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${groupAccount}, ${personalAccount}, 1500, (now() at time zone 'America/Bogota')::date)`;

      // 38: the flow window counts the income and the expense, never the transfer (RF-19, RF-88).
      const [flow] = await flowSums(tx, winStart, winEnd);
      const income = Number(flow.income_cents);
      const expense = Number(flow.expense_cents);
      assert(
        labels[0],
        income === 10000 && expense === 6000 && income - expense === 4000,
        `income = ${income}, expense = ${expense}, net = ${income - expense}`,
      );

      // 39: the split-joined sum counts only the expense's two split rows; the transfer carries none (RF-34).
      const catRows = await categoryTotals(tx, winStart, winEnd);
      const catTotal = catRows.reduce((sum, row) => sum + Number(row.total_cents), 0);
      assert(
        labels[1],
        catRows.length === 2 && catTotal === 6000,
        `rows = ${catRows.length}, total = ${catTotal} (expected 2 rows, 6000)`,
      );

      // 40: the transfer netting credits the source owner for a contribution and debits it for a return (RF-66).
      const contributions = await tx<{ user_id: string; contribution_cents: string }[]>`
        select member.user_id, coalesce(sum(member.delta), 0) as contribution_cents
        from (
          select
            case
              when ta.group_id is not null and fa.owner_user_id is not null then fa.owner_user_id
              when fa.group_id is not null and ta.owner_user_id is not null then ta.owner_user_id
            end as user_id,
            case
              when ta.group_id is not null and fa.owner_user_id is not null then t.amount_cents
              when fa.group_id is not null and ta.owner_user_id is not null then -t.amount_cents
              else 0
            end as delta
          from transactions t
          join accounts fa on fa.id = t.from_account_id
          join accounts ta on ta.id = t.to_account_id
          where t.kind = 'transfer'
            and t.occurred_at >= ${winStart} and t.occurred_at < ${winEnd}
        ) member
        where member.user_id is not null
        group by member.user_id`;
      assert(
        labels[2],
        contributions.length === 1 &&
          contributions[0].user_id === leaderUser &&
          Number(contributions[0].contribution_cents) === 3500,
        `rows = ${contributions.length}, ${contributions[0]?.user_id === leaderUser ? "leader" : "other"} net = ${contributions[0]?.contribution_cents} (expected 3500 = 5000 − 1500)`,
      );

      // A second group with its own leader, accounts, categories and movements, seeded through its own
      // context. The first leader is no member of it, so Phase 1's SELECT policy hides every row.
      await tx`reset role`;
      await enterUserContext(tx, secondLeader);
      await tx`insert into groups (id, name, cash_mode) values (${secondGroup}, 'rls analytics second', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${secondGroup}, ${secondLeader}, 'rls analytics second leader', 'leader')`;
      const [{ id: secondPersonal }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${secondLeader}, 'rls analytics second cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: secondGroupAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${secondGroup}, true, 'rls analytics second group cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: secondExpenseCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${secondLeader}, 'rls analytics second expense', 'expense') returning id`;
      const [{ id: secondIncome }] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at)
        values (${secondPersonal}, 77000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: secondIncomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${secondLeader}, 'rls analytics second income', 'income') returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${secondIncome}, ${secondIncomeCat}, 77000)`;
      const [{ id: secondExpense }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${secondPersonal}, 33000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${secondExpense}, ${secondExpenseCat}, 33000)`;
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${secondPersonal}, ${secondGroupAccount}, 22000, (now() at time zone 'America/Bogota')::date)`;

      // 41: back under the first member, the aggregates hold their earlier totals — the second group is invisible.
      await tx`reset role`;
      await enterUserContext(tx, leaderUser);
      const [isolatedFlow] = await flowSums(tx, winStart, winEnd);
      const isolatedCat = await categoryTotals(tx, winStart, winEnd);
      const isolatedCatTotal = isolatedCat.reduce((sum, row) => sum + Number(row.total_cents), 0);
      assert(
        labels[3],
        Number(isolatedFlow.income_cents) === 10000 &&
          Number(isolatedFlow.expense_cents) === 6000 &&
          isolatedCat.length === 2 &&
          isolatedCatTotal === 6000,
        `income = ${isolatedFlow.income_cents}, expense = ${isolatedFlow.expense_cents}, category rows = ${isolatedCat.length}, category total = ${isolatedCatTotal}`,
      );

      // A first-group income dated in the previous month, otherwise valid. If the date-only window
      // comparison holds, it never touches the current sum.
      const [{ id: staleIncome }] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at)
        values (${personalAccount}, 99999, (date_trunc('month', now() at time zone 'America/Bogota') - interval '1 day')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${staleIncome}, ${incomeCat}, 99999)`;

      // 42: the current window still reads 10000 of income — the previous-month row is filtered out (RNF-06).
      const [windowedFlow] = await flowSums(tx, winStart, winEnd);
      assert(
        labels[4],
        Number(windowedFlow.income_cents) === 10000,
        `income in window = ${windowedFlow.income_cents} (expected 10000, the 99999 stale row excluded)`,
      );

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls analytics%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls analytics%' = ${probeCount}`,
  );
}

// Assertions 44-50: the budgets table. A budget names an expense category of its own scope; the scope
// trigger refuses a foreign or income category; spent derives from the category's expense splits in the
// window, narrowed to one account when the budget names it; any group member writes a group budget and
// a second group's budgets stay invisible. Every fixture is seeded through the app's own policies and
// rolled back.
async function checkBudgetPolicies() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const secondLeader = randomUUID();
  const groupId = randomUUID();
  const secondGroup = randomUUID();

  const labels = [
    "44. a personal budget on an expense category of the caller's scope inserts",
    "45. a budget whose category sits in another scope is refused",
    "46. a budget on an income category is refused",
    "47. spent sums the category's expense splits in the window; a transfer and a foreign-category expense add nothing",
    "48. an account-scoped budget counts only splits whose movement touches that account",
    "49. a plain member inserts, updates and deletes a group budget",
    "50. a member reads the group budget while a second group's budget stays invisible",
  ];
  const tailLabel = "51. the rolled-back budget transaction leaves no trace";

  // Spent derives from the splits on the budget's category, over the window's expenses, optionally
  // narrowed to the movements touching one account (RF-72).
  const spentSum = (
    q: postgres.TransactionSql,
    categoryId: string,
    start: string,
    endExclusive: string,
    accountId: string | null,
  ) =>
    q<{ spent_cents: string }[]>`
      select coalesce(sum(s.amount_cents), 0) as spent_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      where s.category_id = ${categoryId}
        and t.kind = 'expense'
        and t.occurred_at >= ${start} and t.occurred_at < ${endExclusive}
        and (${accountId}::uuid is null
          or t.from_account_id = ${accountId} or t.to_account_id = ${accountId})`;

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser}), (${secondLeader})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser}), (${secondLeader})`;

      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls budgets', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls budgets leader', 'leader')`;

      // The window bounds the report receives: the first of the current Bogotá month and the next.
      const [{ start: winStart, end_exclusive: winEnd }] = await tx<
        { start: string; end_exclusive: string }[]
      >`select
          to_char(date_trunc('month', now() at time zone 'America/Bogota'), 'YYYY-MM-DD') as start,
          to_char(date_trunc('month', now() at time zone 'America/Bogota') + interval '1 month', 'YYYY-MM-DD') as end_exclusive`;

      const [{ id: leaderAccountA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls budgets leader cash A', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: leaderAccountB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls budgets leader cash B', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: budgetCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls budgets category', 'expense') returning id`;
      const [{ id: otherCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls budgets other category', 'expense') returning id`;
      const [{ id: accountCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls budgets account category', 'expense') returning id`;
      const [{ id: incomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls budgets income category', 'income') returning id`;
      const [{ id: groupExpenseCat }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${groupId}, 'rls budgets group category', 'expense') returning id`;

      // 44: a budget on an expense category of the caller's own scope lands.
      const inserted = await tx<{ id: string }[]>`
        insert into budgets (owner_user_id, category_id, period, limit_cents, threshold_pct, name)
        values (${leaderUser}, ${budgetCat}, 'monthly', 50000, 80, 'rls budgets personal') returning id`;
      assert(labels[0], inserted.length === 1, `inserted rows = ${inserted.length}`);

      // 45: the scope trigger refuses a category from another scope (a group category on a personal budget).
      await tx
        .savepoint(async (sp) => {
          await sp`insert into budgets (owner_user_id, category_id, period, limit_cents, threshold_pct)
            values (${leaderUser}, ${groupExpenseCat}, 'monthly', 50000, 80)`;
          assert(labels[1], false, "a foreign-scope category stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 46: the scope trigger refuses an income category — a budget caps spending (RF-71).
      await tx
        .savepoint(async (sp) => {
          await sp`insert into budgets (owner_user_id, category_id, period, limit_cents, threshold_pct)
            values (${leaderUser}, ${incomeCat}, 'monthly', 50000, 80)`;
          assert(labels[2], false, "an income category stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[2], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 47: one expense on the budget's category (7000), one transfer, one expense on another category (3000).
      const [{ id: budgetExpense }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${leaderAccountA}, 7000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${budgetExpense}, ${budgetCat}, 7000)`;
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${leaderAccountA}, ${leaderAccountB}, 2000, (now() at time zone 'America/Bogota')::date)`;
      const [{ id: otherExpense }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${leaderAccountA}, 3000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${otherExpense}, ${otherCat}, 3000)`;
      const [{ spent_cents: budgetSpent }] = await spentSum(tx, budgetCat, winStart, winEnd, null);
      assert(
        labels[3],
        Number(budgetSpent) === 7000,
        `spent = ${budgetSpent} (expected 7000, the transfer and the 3000 other-category expense excluded)`,
      );

      // 48: an account-scoped budget. Two expenses on one category, from two accounts, only one named.
      const [{ id: accountBudget }] = await tx<{ id: string }[]>`
        insert into budgets (owner_user_id, category_id, account_id, period, limit_cents, threshold_pct)
        values (${leaderUser}, ${accountCat}, ${leaderAccountA}, 'monthly', 100000, 90) returning id`;
      const [{ id: onAccount }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${leaderAccountA}, 4000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${onAccount}, ${accountCat}, 4000)`;
      const [{ id: offAccount }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${leaderAccountB}, 2000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${offAccount}, ${accountCat}, 2000)`;
      const [{ spent_cents: narrowed }] = await spentSum(tx, accountCat, winStart, winEnd, leaderAccountA);
      const [{ spent_cents: unnarrowed }] = await spentSum(tx, accountCat, winStart, winEnd, null);
      assert(
        labels[4],
        Number(narrowed) === 4000 && Number(unnarrowed) === 6000,
        `narrowed to the account = ${narrowed} (expected 4000), across accounts = ${unnarrowed} (expected 6000), budget ${accountBudget !== null}`,
      );

      // A group budget the plain member reads below, and a second group's budget it must never see.
      const [{ id: groupBudget }] = await tx<{ id: string }[]>`
        insert into budgets (group_id, category_id, period, limit_cents, threshold_pct, name)
        values (${groupId}, ${groupExpenseCat}, 'monthly', 80000, 70, 'rls budgets group') returning id`;

      // The plain member: seed the membership as the owner, no policy hands one out.
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls budgets member', 'member')`;

      // The second group, seeded through its own leader's context.
      await enterUserContext(tx, secondLeader);
      await tx`insert into groups (id, name, cash_mode) values (${secondGroup}, 'rls budgets second', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${secondGroup}, ${secondLeader}, 'rls budgets second leader', 'leader')`;
      const [{ id: secondCat }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${secondGroup}, 'rls budgets second category', 'expense') returning id`;
      const [{ id: secondBudget }] = await tx<{ id: string }[]>`
        insert into budgets (group_id, category_id, period, limit_cents, threshold_pct)
        values (${secondGroup}, ${secondCat}, 'monthly', 90000, 60) returning id`;

      // 49: a plain member writes a group budget — insert, update and delete all land (any-member rule).
      await enterUserContext(tx, memberUser);
      const memberInsert = await tx<{ id: string }[]>`
        insert into budgets (group_id, category_id, period, limit_cents, threshold_pct, name)
        values (${groupId}, ${groupExpenseCat}, 'weekly', 20000, 50, 'rls budgets member owned') returning id`;
      const memberBudget = memberInsert[0]?.id;
      const memberUpdate = await tx`update budgets set limit_cents = 25000 where id = ${memberBudget}`;
      const memberDelete = await tx`delete from budgets where id = ${memberBudget}`;
      assert(
        labels[5],
        memberInsert.length === 1 && memberUpdate.count === 1 && memberDelete.count === 1,
        `insert rows = ${memberInsert.length}, update rows = ${memberUpdate.count}, delete rows = ${memberDelete.count}`,
      );

      // 50: the member reads the group budget through the universal read; the second group's stays hidden.
      const [{ count: seesGroup }] = await tx<{ count: string }[]>`
        select count(*)::text as count from budgets where id = ${groupBudget}`;
      const [{ count: seesSecond }] = await tx<{ count: string }[]>`
        select count(*)::text as count from budgets where id = ${secondBudget}`;
      assert(
        labels[6],
        seesGroup === "1" && seesSecond === "0",
        `member→group budget = ${seesGroup}, member→second group budget = ${seesSecond}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls budgets%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls budgets%' = ${probeCount}`,
  );
}

// Assertions 52-56: the planned_payments table. The scope and `created_by` are the trigger's, not the
// caller's; write is bounded to own-or-shared accounts; settling from pending is a one-shot idempotent
// link; the settled link is permanent and a done row never returns to pending; and a second group's
// payments stay invisible. Every fixture is seeded through the app's own policies and rolled back.
async function checkPlannedPaymentPolicies() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const secondLeader = randomUUID();
  const groupId = randomUUID();
  const secondGroup = randomUUID();

  const labels = [
    "52. a planned payment holds the trigger's derived scope and created_by, not the caller's",
    "53. a payment touching another member's personal account is refused",
    "54. settling from pending links the transaction once; the second settle touches nothing",
    "55. rewriting the settled transaction is refused, and a done payment cannot return to pending",
    "56. a member reads the group payment while a second group's payment stays invisible",
  ];
  const tailLabel = "57. the rolled-back planned payment transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser}), (${secondLeader})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser}), (${secondLeader})`;

      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls payments', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls payments leader', 'leader')`;

      const [{ id: leaderAccountA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls payments leader cash A', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: leaderAccountB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls payments leader cash B', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: sharedAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${groupId}, true, 'rls payments shared cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;

      // Two real movements the payments settle into.
      const [{ id: settleTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${leaderAccountA}, ${leaderAccountB}, 4000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: otherTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${leaderAccountB}, ${leaderAccountA}, 1000, (now() at time zone 'America/Bogota')::date) returning id`;

      // 52: a payment touching the shared account is group-scoped, its creator stamped — both by the trigger.
      const [groupPayment] = await tx<
        { id: string; owner_user_id: string | null; group_id: string | null; created_by: string; status: string }[]
      >`insert into planned_payments (from_account_id, to_account_id, amount_cents, due_date)
        values (${leaderAccountA}, ${sharedAccount}, 6000, (now() at time zone 'America/Bogota')::date)
        returning id, owner_user_id, group_id, created_by, status`;
      assert(
        labels[0],
        groupPayment.group_id === groupId &&
          groupPayment.owner_user_id === null &&
          groupPayment.created_by === leaderUser &&
          groupPayment.status === "pending",
        `group_id = ${groupPayment.group_id === groupId}, owner = ${groupPayment.owner_user_id}, created_by = ${groupPayment.created_by === leaderUser}, status = ${groupPayment.status}`,
      );

      // A personal pending payment to settle below.
      const [{ id: settlePayment }] = await tx<{ id: string }[]>`
        insert into planned_payments (from_account_id, amount_cents, due_date)
        values (${leaderAccountA}, 3000, (now() at time zone 'America/Bogota')::date) returning id`;

      // The plain member and their personal account, seeded through their own context.
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls payments member', 'member')`;
      await enterUserContext(tx, memberUser);
      const [{ id: memberAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${memberUser}, 'rls payments member cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;

      // 53: the bounded write — the leader may not plan a payment out of the member's personal account.
      await enterUserContext(tx, leaderUser);
      await tx
        .savepoint(async (sp) => {
          await sp`insert into planned_payments (from_account_id, amount_cents, due_date)
            values (${memberAccount}, 3000, (now() at time zone 'America/Bogota')::date)`;
          assert(labels[1], false, "a payment on another's account stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "42501", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 54: the settle is a one-shot guarded by the status. The first stamps and links, the second no-ops.
      const firstSettle = await tx<{ settled_transaction_id: string | null }[]>`
        update planned_payments set status = 'done', settled_transaction_id = ${settleTxn}
        where id = ${settlePayment} and status = 'pending'
        returning settled_transaction_id`;
      const secondSettle = await tx`update planned_payments set status = 'done', settled_transaction_id = ${settleTxn}
        where id = ${settlePayment} and status = 'pending'`;
      assert(
        labels[2],
        firstSettle.count === 1 &&
          firstSettle[0].settled_transaction_id === settleTxn &&
          secondSettle.count === 0,
        `first settle rows = ${firstSettle.count}, linked = ${firstSettle[0]?.settled_transaction_id === settleTxn}, second settle rows = ${secondSettle.count}`,
      );

      // 55: the settled link is permanent, and a done payment never returns to pending (RF-75).
      let rewriteCode: string | undefined;
      let revertCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`update planned_payments set settled_transaction_id = ${otherTxn} where id = ${settlePayment}`;
          assert(labels[3], false, "the settled link was rewritten, which it must not be");
        })
        .catch((error: unknown) => {
          rewriteCode = pgErrorCode(error);
        });
      await tx
        .savepoint(async (sp) => {
          await sp`update planned_payments set status = 'pending' where id = ${settlePayment}`;
          assert(labels[3], false, "a done payment returned to pending, which it must not");
        })
        .catch((error: unknown) => {
          revertCode = pgErrorCode(error);
        });
      assert(
        labels[3],
        rewriteCode === "23514" && revertCode === "23514",
        `rewrite sqlstate ${rewriteCode ?? "none"}, revert sqlstate ${revertCode ?? "none"}`,
      );

      // A second group whose payments the first member must never see, seeded through its own leader.
      await tx`reset role`;
      await enterUserContext(tx, secondLeader);
      await tx`insert into groups (id, name, cash_mode) values (${secondGroup}, 'rls payments second', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${secondGroup}, ${secondLeader}, 'rls payments second leader', 'leader')`;
      const [{ id: secondAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${secondLeader}, 'rls payments second cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: secondPayment }] = await tx<{ id: string }[]>`
        insert into planned_payments (from_account_id, amount_cents, due_date)
        values (${secondAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;

      // 56: the member reads the group payment through the universal read; the second group's stays hidden.
      await enterUserContext(tx, memberUser);
      const [{ count: seesGroup }] = await tx<{ count: string }[]>`
        select count(*)::text as count from planned_payments where id = ${groupPayment.id}`;
      const [{ count: seesSecond }] = await tx<{ count: string }[]>`
        select count(*)::text as count from planned_payments where id = ${secondPayment}`;
      assert(
        labels[4],
        seesGroup === "1" && seesSecond === "0",
        `member→group payment = ${seesGroup}, member→second group payment = ${seesSecond}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls payments%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls payments%' = ${probeCount}`,
  );
}

// Assertions 58-61, 103-104: the savings_goals and goal_contributions tables. A contribution earmarks a
// movement of the goal's scope and `goal_progress` derives the saved figure from it; a virtual contribution
// earmarks no movement yet still counts; the scope trigger refuses a foreign-scope movement; any group
// member writes a group goal and attaches a contribution while an intruder's virtual insert is barred; and a
// second group's goals stay invisible. Every fixture is seeded through the app's own policies and rolled back.
async function checkSavingsGoalPolicies() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const secondLeader = randomUUID();
  const groupId = randomUUID();
  const secondGroup = randomUUID();

  const labels = [
    "58. a contribution of the goal's scope inserts and goal_progress derives the saved figure",
    "59. a contribution earmarking a movement of another scope is refused",
    "60. a plain member inserts, updates and deletes a group goal and attaches a contribution",
    "61. a member reads the group goal while a second group's goal stays invisible",
    "103. a virtual contribution earmarking no movement lands and goal_progress sums it",
    "104. an intruder outside the goal's scope cannot insert even a virtual contribution",
  ];
  const tailLabel = "62. the rolled-back savings goal transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser}), (${secondLeader})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser}), (${secondLeader})`;

      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls goals', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls goals leader', 'leader')`;

      const [{ id: leaderAccountA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls goals leader cash A', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: leaderAccountB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls goals leader cash B', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: sharedAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${groupId}, true, 'rls goals shared cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;

      // A personal goal and a personal movement that shares its scope.
      const [{ id: personalGoal }] = await tx<{ id: string }[]>`
        insert into savings_goals (owner_user_id, name, target_amount_cents)
        values (${leaderUser}, 'rls goals personal', 200000) returning id`;
      const [{ id: personalTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${leaderAccountA}, ${leaderAccountB}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;
      // A group movement, of a different scope, seeded here for the refusal below.
      const [{ id: groupTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${leaderAccountA}, ${sharedAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;

      // 58: the contribution lands and the derived progress equals it.
      const contribution = await tx<{ id: string }[]>`
        insert into goal_contributions (goal_id, transaction_id, amount_cents)
        values (${personalGoal}, ${personalTxn}, 5000) returning id`;
      const [{ saved_cents: saved }] = await tx<{ saved_cents: string }[]>`
        select saved_cents from goal_progress where goal_id = ${personalGoal}`;
      assert(
        labels[0],
        contribution.length === 1 && Number(saved) === 5000,
        `inserted rows = ${contribution.length}, goal_progress.saved_cents = ${saved} (expected 5000)`,
      );

      // 103: a virtual contribution earmarks no movement (RF-87); it still lands and goal_progress sums it.
      const [{ saved_cents: beforeVirtual }] = await tx<{ saved_cents: string }[]>`
        select saved_cents from goal_progress where goal_id = ${personalGoal}`;
      const virtualContribution = await tx<{ id: string }[]>`
        insert into goal_contributions (goal_id, transaction_id, amount_cents)
        values (${personalGoal}, null, 7000) returning id`;
      const [{ saved_cents: afterVirtual }] = await tx<{ saved_cents: string }[]>`
        select saved_cents from goal_progress where goal_id = ${personalGoal}`;
      assert(
        labels[4],
        virtualContribution.length === 1 && Number(afterVirtual) - Number(beforeVirtual) === 7000,
        `inserted rows = ${virtualContribution.length}, saved_cents ${beforeVirtual} → ${afterVirtual} (expected +7000)`,
      );

      // 59: the scope trigger refuses a movement of another scope on the personal goal.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into goal_contributions (goal_id, transaction_id, amount_cents)
            values (${personalGoal}, ${groupTxn}, 5000)`;
          assert(labels[1], false, "a foreign-scope movement was earmarked, which it must not be");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // A group goal the plain member reads below, seeded by the leader.
      const [{ id: groupGoal }] = await tx<{ id: string }[]>`
        insert into savings_goals (group_id, name, target_amount_cents)
        values (${groupId}, 'rls goals group', 400000) returning id`;

      // The plain member, seeded through their own context.
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls goals member', 'member')`;

      // The second group, seeded through its own leader.
      await enterUserContext(tx, secondLeader);
      await tx`insert into groups (id, name, cash_mode) values (${secondGroup}, 'rls goals second', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${secondGroup}, ${secondLeader}, 'rls goals second leader', 'leader')`;
      const [{ id: secondGoal }] = await tx<{ id: string }[]>`
        insert into savings_goals (group_id, name, target_amount_cents)
        values (${secondGroup}, 'rls goals second goal', 300000) returning id`;

      // 104: the intruder's identical virtual insert on the leader's personal goal is barred by the write policy.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into goal_contributions (goal_id, transaction_id, amount_cents)
            values (${personalGoal}, null, 7000)`;
          assert(labels[5], false, "an intruder's virtual contribution stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[5], pgErrorCode(error) === "42501", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 60: a plain member writes a group goal — insert, update, contribute and delete all land.
      await enterUserContext(tx, memberUser);
      const [{ id: memberAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${memberUser}, 'rls goals member cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const memberInsert = await tx<{ id: string }[]>`
        insert into savings_goals (group_id, name, target_amount_cents)
        values (${groupId}, 'rls goals member owned', 150000) returning id`;
      const memberGoal = memberInsert[0]?.id;
      const memberUpdate = await tx`update savings_goals set name = 'rls goals member renamed' where id = ${memberGoal}`;
      // A group movement the member may write: their own account into the shared account.
      const [{ id: memberGroupTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${memberAccount}, ${sharedAccount}, 2500, (now() at time zone 'America/Bogota')::date) returning id`;
      const memberContribution = await tx<{ id: string }[]>`
        insert into goal_contributions (goal_id, transaction_id, amount_cents)
        values (${memberGoal}, ${memberGroupTxn}, 2500) returning id`;
      const memberDelete = await tx`delete from savings_goals where id = ${memberGoal}`;
      assert(
        labels[2],
        memberInsert.length === 1 &&
          memberUpdate.count === 1 &&
          memberContribution.length === 1 &&
          memberDelete.count === 1,
        `insert rows = ${memberInsert.length}, update rows = ${memberUpdate.count}, contribution rows = ${memberContribution.length}, delete rows = ${memberDelete.count}`,
      );

      // 61: the member reads the group goal through the universal read; the second group's stays hidden.
      const [{ count: seesGroup }] = await tx<{ count: string }[]>`
        select count(*)::text as count from savings_goals where id = ${groupGoal}`;
      const [{ count: seesSecond }] = await tx<{ count: string }[]>`
        select count(*)::text as count from savings_goals where id = ${secondGoal}`;
      assert(
        labels[3],
        seesGroup === "1" && seesSecond === "0",
        `member→group goal = ${seesGroup}, member→second group goal = ${seesSecond}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls goals%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls goals%' = ${probeCount}`,
  );
}

// Assertions 63-69: the debt_terms table. A profile attaches only to a liability the caller may write;
// the liability trigger, the amount-XOR-percentage check and the due-day range each reject a bad row;
// read is universal inside the group and a non-writer cannot mint a profile on another member's personal
// liability. Every fixture is seeded through the app's own policies and rolled back.
async function checkDebtTermsPolicies() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const secondLeader = randomUUID();
  const groupId = randomUUID();
  const secondGroup = randomUUID();

  const labels = [
    "63. a profile on the caller's own liability inserts",
    "64. a profile on an asset account is refused",
    "65. a minimum set as both an amount and a percentage is refused",
    "66. a payment due day outside 1..31 is refused",
    "67. a second group's debt terms stay invisible",
    "68. a member reads a group liability's terms",
    "69. a non-writer cannot mint terms on another member's personal liability",
  ];
  const tailLabel = "70. the rolled-back debt terms transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser}), (${secondLeader})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser}), (${secondLeader})`;

      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls debt terms', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls debt terms leader', 'leader')`;

      // A liability with a profile below, an asset the trigger rejects, a second liability for the check
      // constraints (which roll back, so it stays profileless), and a group liability the member reads.
      const [{ id: liabilityA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${leaderUser}, 'rls debt terms leader card', 'liability', -500000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: assetAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls debt terms leader cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: liabilityB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${leaderUser}, 'rls debt terms leader card B', 'liability', -100000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: groupLiability }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_cents, initial_balance_on)
        values (${groupId}, true, 'rls debt terms group card', 'liability', -200000, (now() at time zone 'America/Bogota')::date) returning id`;

      // 63: a profile on the caller's own liability lands.
      const inserted = await tx<{ account_id: string }[]>`
        insert into debt_terms (account_id, debt_kind, annual_rate, minimum_payment_pct, credit_limit_cents, statement_cut_off_day, payment_due_day)
        values (${liabilityA}, 'revolving', 0.28, 0.05, 1500000, 15, 5) returning account_id`;
      assert(labels[0], inserted.length === 1, `inserted rows = ${inserted.length}`);

      // 64: the liability trigger refuses a profile on an asset account.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into debt_terms (account_id, debt_kind, annual_rate)
            values (${assetAccount}, 'revolving', 0.28)`;
          assert(labels[1], false, "a profile on an asset stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 65: the minimum is a fixed amount XOR a percentage — both at once is refused.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into debt_terms (account_id, debt_kind, annual_rate, minimum_payment_cents, minimum_payment_pct)
            values (${liabilityB}, 'revolving', 0.28, 50000, 0.05)`;
          assert(labels[2], false, "both an amount and a percentage stood, which they must not");
        })
        .catch((error: unknown) => {
          assert(labels[2], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 66: the payment due day is a real day of month — 0 and 32 are both refused.
      let dueZeroCode: string | undefined;
      let dueOverCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`insert into debt_terms (account_id, debt_kind, annual_rate, payment_due_day)
            values (${liabilityB}, 'revolving', 0.28, 0)`;
        })
        .catch((error: unknown) => {
          dueZeroCode = pgErrorCode(error);
        });
      await tx
        .savepoint(async (sp) => {
          await sp`insert into debt_terms (account_id, debt_kind, annual_rate, payment_due_day)
            values (${liabilityB}, 'revolving', 0.28, 32)`;
        })
        .catch((error: unknown) => {
          dueOverCode = pgErrorCode(error);
        });
      assert(
        labels[3],
        dueZeroCode === "23514" && dueOverCode === "23514",
        `day 0 sqlstate ${dueZeroCode ?? "none"}, day 32 sqlstate ${dueOverCode ?? "none"}`,
      );

      // Terms on the group liability, for the member read below.
      await tx`insert into debt_terms (account_id, debt_kind, annual_rate, minimum_payment_pct)
        values (${groupLiability}, 'revolving', 0.30, 0.05)`;

      // The plain member, seeded as the owner — no policy hands out a membership.
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls debt terms member', 'member')`;

      // A second group with its own leader and a liability whose terms the subject must never see.
      await enterUserContext(tx, secondLeader);
      await tx`insert into groups (id, name, cash_mode) values (${secondGroup}, 'rls debt terms second', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${secondGroup}, ${secondLeader}, 'rls debt terms second leader', 'leader')`;
      const [{ id: secondLiability }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${secondLeader}, 'rls debt terms second card', 'liability', -300000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into debt_terms (account_id, debt_kind, annual_rate, minimum_payment_pct)
        values (${secondLiability}, 'revolving', 0.25, 0.04)`;

      // 67: back under the subject, the second group's terms are invisible.
      await enterUserContext(tx, leaderUser);
      const [{ count: seesSecond }] = await tx<{ count: string }[]>`
        select count(*)::text as count from debt_terms where account_id = ${secondLiability}`;
      assert(labels[4], seesSecond === "0", `subject→second terms = ${seesSecond}`);

      // 68: the member reads the group liability's terms through the universal read.
      await enterUserContext(tx, memberUser);
      const [{ count: seesGroup }] = await tx<{ count: string }[]>`
        select count(*)::text as count from debt_terms where account_id = ${groupLiability}`;
      assert(labels[5], seesGroup === "1", `member→group terms = ${seesGroup}`);

      // 69: the member cannot mint terms on the leader's personal liability.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into debt_terms (account_id, debt_kind, annual_rate)
            values (${liabilityB}, 'revolving', 0.28)`;
          assert(labels[6], false, "a non-writer minted terms, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[6], pgErrorCode(error) === "42501", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls debt terms%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls debt terms%' = ${probeCount}`,
  );
}

// Assertions 71-76: the installment plans, their lines and the oldest-first allocator. A plan attaches
// only to a liability; a line links only to a movement touching the plan's account; and the FIFO walk,
// replicated inline, settles the fully-covered lines in due order, leaves the remainder unassigned and
// unwinds on deletion of the paying movement. Every fixture is seeded through the app's own policies and
// rolled back.
async function checkInstallmentPolicies() {
  console.log("");
  const leaderUser = randomUUID();

  const labels = [
    "71. a plan on the caller's liability inserts with its lines",
    "72. a plan on an asset account is refused",
    "73. a line links to a movement touching the plan account and rejects one that does not",
    "74. a 200000 payment settles exactly the two oldest 100000 lines and leaves the third unpaid",
    "75. a 150000 payment settles only the first line and leaves the remainder unassigned",
    "76. deleting the paying movement unlinks every line and restores the full pending",
  ];
  const tailLabel = "77. the rolled-back installment transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser})`;
      await tx`insert into app_users (id) values (${leaderUser})`;
      await enterUserContext(tx, leaderUser);

      // The oldest-first FIFO allocator (RF-82), replicated inline against this transaction's own
      // connection: it links each fully-covered line to the payment in due order, subtracting its amount
      // from a running remainder, and stops at the first line the remainder cannot cover in full. A line
      // is never partially paid; the leftover remainder stays unassigned.
      const allocate = async (planId: string, paymentId: string, amount: number) => {
        const lines = await tx<{ id: string; amount_cents: string }[]>`
          select id, amount_cents from installment_lines
          where plan_id = ${planId} and paid_transaction_id is null
          order by due_date, seq`;
        let remainder = amount;
        for (const line of lines) {
          const owed = Number(line.amount_cents);
          if (remainder < owed) break;
          remainder -= owed;
          await tx`update installment_lines set paid_transaction_id = ${paymentId} where id = ${line.id}`;
        }
      };

      const [{ id: liability }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${leaderUser}, 'rls installment card', 'liability', -900000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: cash }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${leaderUser}, 'rls installment cash', 'asset', 1000000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: cashB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls installment cash B', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;

      // 71: a plan on the caller's liability lands with its three lines.
      const [{ id: plan1 }] = await tx<{ id: string }[]>`
        insert into installment_plans (account_id, principal_cents, n_installments, frequency, start_date)
        values (${liability}, 300000, 3, 'monthly', (now() at time zone 'America/Bogota')::date) returning id`;
      const plan1Lines = await tx<{ id: string }[]>`
        insert into installment_lines (plan_id, seq, due_date, amount_cents) values
          (${plan1}, 1, '2026-01-15', 100000),
          (${plan1}, 2, '2026-02-15', 100000),
          (${plan1}, 3, '2026-03-15', 100000) returning id`;
      assert(labels[0], plan1Lines.length === 3, `line rows = ${plan1Lines.length}`);

      // 72: the plan trigger refuses a plan on an asset account.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into installment_plans (account_id, principal_cents, n_installments, frequency, start_date)
            values (${cash}, 300000, 3, 'monthly', (now() at time zone 'America/Bogota')::date)`;
          assert(labels[1], false, "a plan on an asset stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "23514", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 73: a settling movement must touch the plan's account. A cash→card transfer does; cash→cash does not.
      const [{ id: touchingTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${cash}, ${liability}, 50000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: nonTouchingTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${cash}, ${cashB}, 50000, (now() at time zone 'America/Bogota')::date) returning id`;
      const linkTouching = await tx`update installment_lines set paid_transaction_id = ${touchingTxn}
        where plan_id = ${plan1} and seq = 1`;
      let nonTouchCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`update installment_lines set paid_transaction_id = ${nonTouchingTxn}
            where plan_id = ${plan1} and seq = 2`;
        })
        .catch((error: unknown) => {
          nonTouchCode = pgErrorCode(error);
        });
      assert(
        labels[2],
        linkTouching.count === 1 && nonTouchCode === "23514",
        `touching link rows = ${linkTouching.count}, non-touching sqlstate ${nonTouchCode ?? "none"}`,
      );

      // 74: a 200000 payment covers the two oldest 100000 lines in full and stops; the third stays unpaid.
      const [{ id: plan2 }] = await tx<{ id: string }[]>`
        insert into installment_plans (account_id, principal_cents, n_installments, frequency, start_date)
        values (${liability}, 300000, 3, 'monthly', (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into installment_lines (plan_id, seq, due_date, amount_cents) values
        (${plan2}, 1, '2026-04-15', 100000),
        (${plan2}, 2, '2026-05-15', 100000),
        (${plan2}, 3, '2026-06-15', 100000)`;
      const [{ id: paymentA }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${cash}, ${liability}, 200000, (now() at time zone 'America/Bogota')::date) returning id`;
      await allocate(plan2, paymentA, 200000);
      const paidA = await tx<{ seq: number; paid: boolean }[]>`
        select seq, paid_transaction_id is not null as paid from installment_lines
        where plan_id = ${plan2} order by seq`;
      assert(
        labels[3],
        paidA.length === 3 && paidA[0].paid && paidA[1].paid && !paidA[2].paid,
        `paid by seq = ${paidA.map((row) => `${row.seq}:${row.paid}`).join(", ")}`,
      );

      // 75: a 150000 payment covers only the first line; the 50000 remainder never touches the second.
      const [{ id: plan3 }] = await tx<{ id: string }[]>`
        insert into installment_plans (account_id, principal_cents, n_installments, frequency, start_date)
        values (${liability}, 300000, 3, 'monthly', (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into installment_lines (plan_id, seq, due_date, amount_cents) values
        (${plan3}, 1, '2026-07-15', 100000),
        (${plan3}, 2, '2026-08-15', 100000),
        (${plan3}, 3, '2026-09-15', 100000)`;
      const [{ id: paymentB }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${cash}, ${liability}, 150000, (now() at time zone 'America/Bogota')::date) returning id`;
      await allocate(plan3, paymentB, 150000);
      const paidB = await tx<{ seq: number; paid: boolean }[]>`
        select seq, paid_transaction_id is not null as paid from installment_lines
        where plan_id = ${plan3} order by seq`;
      const [{ pending: pendingB }] = await tx<{ pending: string }[]>`
        select coalesce(sum(amount_cents) filter (where paid_transaction_id is null), 0)::text as pending
        from installment_lines where plan_id = ${plan3}`;
      assert(
        labels[4],
        paidB[0].paid && !paidB[1].paid && !paidB[2].paid && pendingB === "200000",
        `paid by seq = ${paidB.map((row) => `${row.seq}:${row.paid}`).join(", ")}, pending = ${pendingB}`,
      );

      // 76: deleting the paying movement (FK set null) unlinks every covered line and the pending returns
      // to the full 300000 sum.
      await tx`delete from transactions where id = ${paymentA}`;
      const [afterDelete] = await tx<{ paid: string; pending: string }[]>`
        select
          count(*) filter (where paid_transaction_id is not null)::text as paid,
          coalesce(sum(amount_cents) filter (where paid_transaction_id is null), 0)::text as pending
        from installment_lines where plan_id = ${plan2}`;
      assert(
        labels[5],
        afterDelete.paid === "0" && afterDelete.pending === "300000",
        `linked lines after delete = ${afterDelete.paid}, pending = ${afterDelete.pending}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls installment%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls installment%' = ${probeCount}`,
  );
}

// Assertions 78-79: the derived debt figures. No new policy ships — what is proved is that the overview's
// arithmetic reads true. The monthly interest is the effective twelfth-root step of the annual rate, not
// the linear annual/12; available credit nets the limit against the pocket the card settles in; and what a
// person calls "total owed" is one figure per currency, which an installment plan (a schedule, never a
// movement) leaves untouched. The same SQL the overview runs is replicated inline, and every fixture is
// seeded through the app's own policies and rolled back.
//
// Both cards hold a foreign purchase still on estimate, so every figure here is read off a card that
// really carries two pockets (RF-121). A credit limit and an interest charge are denominated in the
// currency the card settles in, so each reads that pocket and no other; and a sum across the two cards
// can only answer per currency, because adding a dollar to a peso is the one thing RF-124 forbids.
async function checkDebtDerivedFigures() {
  console.log("");
  const leaderUser = randomUUID();

  const labels = [
    "78. the monthly interest reads off one pocket only, the effective rate, matching the hand figure and unlike the linear one",
    "79. available credit nets the limit against the settlement pocket, and total owed answers one figure per currency that a plan never double-counts",
  ];
  const tailLabel = "80. the rolled-back debt figures transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  // The liability is seeded at −1000000, so the owed magnitude is 1000000 at a 0.28 effective annual rate.
  const owed = 1000000;
  const rate = 0.28;
  const expectedEffective = Math.round(owed * (Math.pow(1 + rate, 1 / 12) - 1));
  const expectedLinear = Math.round((owed * rate) / 12);

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser})`;
      await tx`insert into app_users (id) values (${leaderUser})`;
      await enterUserContext(tx, leaderUser);

      const [{ id: cardA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${leaderUser}, 'rls debt figures card A', 'liability', -1000000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: cardB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${leaderUser}, 'rls debt figures card B', 'liability', -500000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into debt_terms (account_id, debt_kind, annual_rate, minimum_payment_pct, credit_limit_cents)
        values (${cardA}, 'revolving', ${rate}, 0.05, 1500000)`;
      await tx`insert into debt_terms (account_id, debt_kind, annual_rate, minimum_payment_pct, credit_limit_cents)
        values (${cardB}, 'revolving', 0.24, 0.05, 800000)`;

      // A purchase abroad on card B, in dollars and still on estimate: RF-123 keeps it in the currency
      // it was spent in until a statement says what the issuer billed, so the card holds a USD pocket of
      // −20000 beside its COP pocket of −500000. One-sided, so it carries the split RF-69 demands.
      const [{ id: leaderExpenseCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls debt figures abroad', 'expense') returning id`;
      const [{ id: abroad }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, currency, counter_amount_cents, counter_is_estimate)
        values (${cardB}, 20000, (now() at time zone 'America/Bogota')::date, 'USD', 80000, true) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${abroad}, ${leaderExpenseCat}, 20000)`;

      // Card A carries one too, so 78 reads a card that really holds two pockets. Without it the
      // unbounded join returned one row whatever it named, and the assertion passed on a fixture
      // that could not fail — the same shape 79 was fixed out of.
      const [{ id: abroadA }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, currency, counter_amount_cents, counter_is_estimate)
        values (${cardA}, 30000, (now() at time zone 'America/Bogota')::date, 'USD', 120000, true) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${abroadA}, ${leaderExpenseCat}, 30000)`;

      // 78: the SQL effective estimate matches the hand figure and diverges from the linear one.
      const rates = await tx<{ effective: string; linear: string }[]>`
        select
          round(abs(b.balance_cents) * (power(1 + dt.annual_rate, 1.0/12) - 1))::bigint as effective,
          round(abs(b.balance_cents) * dt.annual_rate / 12)::bigint as linear
        from account_balances b
        join accounts a on a.id = b.id and a.settlement_currency = b.currency
        join debt_terms dt on dt.account_id = b.id
        where b.id = ${cardA}`;
      // The row count is the point. Destructuring the first row passed with the join unbounded, because
      // Postgres happened to hand back the settlement pocket first; asked for the count, the same fixture
      // answers two and the assertion falls. A figure that reads true off an arbitrary row proves nothing.
      const figures = rates[0];
      assert(
        labels[0],
        rates.length === 1 &&
          Number(figures?.effective) === expectedEffective &&
          Number(figures?.linear) === expectedLinear &&
          figures?.effective !== figures?.linear,
        `rows = ${rates.length} (expected 1), effective = ${figures?.effective} (expected ${expectedEffective}), linear = ${figures?.linear} (expected ${expectedLinear})`,
      );

      // 79: available credit = limit − the settlement pocket's owed, one row per card because the join
      // names the currency; total owed is a vector, one entry per currency the two cards hold. Materialising
      // an installment plan over one card adds a schedule, no movement, so neither figure budges.
      const availableCredit = () =>
        tx<{ id: string; available: string }[]>`
          select b.id, (dt.credit_limit_cents - abs(b.balance_cents))::text as available
          from account_balances b
          join accounts a on a.id = b.id and a.settlement_currency = b.currency
          join debt_terms dt on dt.account_id = b.id
          where b.id in (${cardA}, ${cardB})`;
      const totalOwed = () =>
        tx<{ currency: string; owed: string }[]>`
          select currency, sum(balance_cents)::text as owed
          from account_balances
          where id in (${cardA}, ${cardB})
          group by currency
          order by currency`;
      // A vector reads as one string so a missing pocket, an extra one and a wrong figure all fail alike.
      const owedVector = (rows: { currency: string; owed: string }[]) =>
        rows.map((row) => `${row.currency} ${row.owed}`).join(", ");
      const expectedOwed = "COP -1500000, USD -50000";

      const creditBefore = await availableCredit();
      const owedBefore = owedVector(await totalOwed());
      const [{ id: plan }] = await tx<{ id: string }[]>`
        insert into installment_plans (account_id, principal_cents, n_installments, frequency, start_date)
        values (${cardA}, 900000, 3, 'monthly', (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into installment_lines (plan_id, seq, due_date, amount_cents) values
        (${plan}, 1, '2026-01-15', 300000),
        (${plan}, 2, '2026-02-15', 300000),
        (${plan}, 3, '2026-03-15', 300000)`;
      const owedAfter = owedVector(await totalOwed());

      const availableOf = (id: string) =>
        creditBefore.find((row) => row.id === id)?.available ?? "no row";
      assert(
        labels[1],
        creditBefore.length === 2 &&
          availableOf(cardA) === "500000" &&
          availableOf(cardB) === "300000" &&
          owedBefore === expectedOwed &&
          owedAfter === expectedOwed,
        `credit rows = ${creditBefore.length} (expected 2), available A = ${availableOf(cardA)} (expected 500000), available B = ${availableOf(cardB)} (expected 300000), owed before = ${owedBefore}, after plan = ${owedAfter} (expected ${expectedOwed})`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls debt figures%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls debt figures%' = ${probeCount}`,
  );
}

// Assertions 81-85, 275 and 276: the account_statements snapshots. The generator, replicated inline, freezes
// the balance to the movements on or before a past cut-off; the unique key makes a re-run a no-op; and the
// snapshot is immutable — no UPDATE and no DELETE grant, so not even its owner rewrites or erases it — and
// gated by the account's scope, so an unrelated user can neither read nor mint one. Only the account's own
// cascade takes a statement away. Every fixture is seeded through the app's own policies and rolled back.
async function checkAccountStatementPolicies() {
  console.log("");
  const subject = randomUUID();
  const otherUser = randomUUID();

  const labels = [
    "81. the statement balance counts only what settled in the card's own currency on or before the cut-off",
    "82. re-running the same insert under the unique key inserts nothing",
    "83. an update of a statement by authenticated is refused",
    "84. an unrelated member can neither read nor write a statement on the subject's liability",
    "275. the statement's own owner is refused the delete and the row survives it",
    "276. deleting the liability account still carries its statement off",
  ];
  const tailLabel = "85. the rolled-back account statement transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${otherUser})`;
      await tx`insert into app_users (id) values (${subject}), (${otherUser})`;
      await enterUserContext(tx, subject);

      // Both open on the previous month's first day, before every movement below (RF-162).
      const [{ id: card }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${subject}, 'rls debt statement card', 'liability', -200000, (date_trunc('month', now() at time zone 'America/Bogota') - interval '1 month')::date) returning id`;
      const [{ id: cash }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${subject}, 'rls debt statement cash', 'asset', 1000000, (date_trunc('month', now() at time zone 'America/Bogota') - interval '1 month')::date) returning id`;
      await tx`insert into debt_terms (account_id, debt_kind, annual_rate, minimum_payment_pct, statement_cut_off_day, payment_due_day)
        values (${card}, 'revolving', 0.28, 0.05, 28, 15)`;

      // A past cut-off in Bogotá and sane bounds around it: the previous month's last day as the cut-off,
      // its month start as the period start, a due date a fortnight on. A payment lands before the cut-off,
      // a purchase after it (RNF-06 — every bound is a YYYY-MM-DD string).
      const [dates] = await tx<
        {
          cut_off: string;
          period_start: string;
          payment_due: string;
          before_cut: string;
          after_cut: string;
        }[]
      >`
        select
          to_char((date_trunc('month', now() at time zone 'America/Bogota') - interval '1 day'), 'YYYY-MM-DD') as cut_off,
          to_char((date_trunc('month', now() at time zone 'America/Bogota') - interval '1 month'), 'YYYY-MM-DD') as period_start,
          to_char((date_trunc('month', now() at time zone 'America/Bogota') - interval '1 day') + interval '15 days', 'YYYY-MM-DD') as payment_due,
          to_char((date_trunc('month', now() at time zone 'America/Bogota') - interval '10 days'), 'YYYY-MM-DD') as before_cut,
          to_char((date_trunc('month', now() at time zone 'America/Bogota') + interval '5 days'), 'YYYY-MM-DD') as after_cut`;

      // A payment (cash→card, +30000) before the cut-off and a purchase (card→cash, −50000) after it.
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${cash}, ${card}, 30000, ${dates.before_cut})`;
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${card}, ${cash}, 50000, ${dates.after_cut})`;

      // Two purchases abroad before the cut-off, both in dollars on a card that settles in pesos. The
      // first is confirmed, so it settled at its counter amount of 80000; the second is still an estimate,
      // so nothing has settled yet and the statement owes nothing for it (RF-123). Both are one-sided and
      // carry the split RF-69 demands.
      const [{ id: abroadCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${subject}, 'rls debt statement abroad', 'expense') returning id`;
      const [{ id: settled }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, currency, counter_amount_cents, counter_is_estimate)
        values (${card}, 20000, ${dates.before_cut}, 'USD', 80000, false) returning id`;
      const [{ id: pending }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, currency, counter_amount_cents, counter_is_estimate)
        values (${card}, 10000, ${dates.before_cut}, 'USD', 40000, true) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values
        (${settled}, ${abroadCat}, 20000),
        (${pending}, ${abroadCat}, 10000)`;

      // The statement generator, replicated inline: the balance is the opening figure plus the signed
      // movement sum windowed to the cut-off and the minimum a percentage of it. It records no interest —
      // no issuer told it what was charged (RF-130). Guarded by the unique key so a re-run inserts
      // nothing (RF-84).
      //
      // `account_statements.closing_balance_cents` is one integer with no currency beside it, so a statement
      // can only be what the issuer bills: the card's settlement pocket, and never a sum across pockets
      // (RF-124). That is the settlement branch of `account_balances`, replicated here — a movement in the
      // card's own currency counts its amount; one in another currency counts its counter amount once
      // confirmed; and one still on estimate counts nothing, because it is the statement that settles it
      // (RF-123). Summing `amount_cents` alone would add dollars to pesos.
      const generate = () =>
        tx<{ closing_balance_cents: string }[]>`
          insert into account_statements
            (account_id, period_start, cut_off_date, payment_due_date, closing_balance_cents, minimum_payment_cents)
          select ${card}, ${dates.period_start}, ${dates.cut_off}, ${dates.payment_due},
            bal.statement_balance,
            round(abs(bal.statement_balance) * dt.minimum_payment_pct)::bigint
          from debt_terms dt
          join accounts a on a.id = dt.account_id
          cross join lateral (
            select a.initial_balance_cents
              + coalesce((select sum(case
                    when t.currency = a.settlement_currency then t.amount_cents
                    when t.counter_amount_cents is not null and not t.counter_is_estimate then t.counter_amount_cents
                    else 0 end)
                  from transactions t
                  where t.to_account_id = ${card} and t.occurred_at <= ${dates.cut_off}), 0)
              - coalesce((select sum(case
                    when t.currency = a.settlement_currency then t.amount_cents
                    when t.counter_amount_cents is not null and not t.counter_is_estimate then t.counter_amount_cents
                    else 0 end)
                  from transactions t
                  where t.from_account_id = ${card} and t.occurred_at <= ${dates.cut_off}), 0)
              as statement_balance
          ) bal
          where dt.account_id = ${card}
          on conflict (account_id, cut_off_date) do nothing
          returning closing_balance_cents`;

      // 81: the windowed balance is −200000 + 30000 − 80000 = −250000. The post-cut −50000 purchase is
      // excluded by the window; the estimated USD 100 purchase by not having settled.
      const first = await generate();
      assert(
        labels[0],
        first.length === 1 && first[0].closing_balance_cents === "-250000",
        `inserted rows = ${first.length}, closing balance = ${first[0]?.closing_balance_cents} (expected -250000)`,
      );

      // 82: the second run collides on (account_id, cut_off_date) and inserts nothing.
      const second = await generate();
      assert(labels[1], second.length === 0, `second-run inserted rows = ${second.length}`);

      // 83: no UPDATE grant on account_statements — a rewrite is refused outright (immutability).
      const [{ id: statementId }] = await tx<{ id: string }[]>`
        select id from account_statements where account_id = ${card} and cut_off_date = ${dates.cut_off}`;
      let updateCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`update account_statements set closing_balance_cents = 0 where id = ${statementId}`;
        })
        .catch((error: unknown) => {
          updateCode = pgErrorCode(error);
        });
      assert(labels[2], updateCode === "42501", `sqlstate ${updateCode ?? "none"}`);

      // 84: an unrelated user (no shared group) sees no statement on the subject's liability and cannot
      // mint one there. The distinct cut-off keeps the unique key clear, so only the write policy can reject.
      await enterUserContext(tx, otherUser);
      const [{ count: otherSees }] = await tx<{ count: string }[]>`
        select count(*)::text as count from account_statements where id = ${statementId}`;
      let otherInsertCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`insert into account_statements
            (account_id, period_start, cut_off_date, payment_due_date, closing_balance_cents, minimum_payment_cents, interest_charged_cents)
            values (${card}, ${dates.period_start}, ${dates.before_cut}, ${dates.payment_due}, -100000, 5000, 2000)`;
        })
        .catch((error: unknown) => {
          otherInsertCode = pgErrorCode(error);
        });
      assert(
        labels[3],
        otherSees === "0" && otherInsertCode === "42501",
        `unrelated read = ${otherSees}, unrelated insert sqlstate ${otherInsertCode ?? "none"}`,
      );

      // 275: neither DELETE policy nor DELETE grant survives on the table, so the one caller who reads the
      // row and writes everything else on its account is refused it too — the snapshot is a record (RF-84).
      await enterUserContext(tx, subject);
      let deleteCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`delete from account_statements where id = ${statementId}`;
        })
        .catch((error: unknown) => {
          deleteCode = pgErrorCode(error);
        });
      const [{ count: afterRefusal }] = await tx<{ count: string }[]>`
        select count(*)::text as count from account_statements where id = ${statementId}`;
      assert(
        labels[4],
        deleteCode === "42501" && afterRefusal === "1",
        `sqlstate ${deleteCode ?? "none"}, rows left = ${afterRefusal}`,
      );

      // 276: the control for 275 — a statement nothing can reach would satisfy it just as well. Referential
      // integrity runs outside row security and outside the grant, so the account's cascade still takes the
      // statement with it. The card's two movements hold the account under `on delete restrict` and go first;
      // both counts are read as `postgres`, so an unreadable row would show up as 0 before the delete.
      await tx`reset role`;
      const [{ count: beforeCascade }] = await tx<{ count: string }[]>`
        select count(*)::text as count from account_statements where id = ${statementId}`;
      await enterUserContext(tx, subject);
      await tx`delete from transactions where from_account_id = ${card} or to_account_id = ${card}`;
      await tx`delete from accounts where id = ${card}`;
      await tx`reset role`;
      const [{ count: afterCascade }] = await tx<{ count: string }[]>`
        select count(*)::text as count from account_statements where id = ${statementId}`;
      assert(
        labels[5],
        beforeCascade === "1" && afterCascade === "0",
        `rows before the account went = ${beforeCascade}, after = ${afterCascade}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls debt statement%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls debt statement%' = ${probeCount}`,
  );
}

// Assertions 86-93: the webhook credentials. The owner-scoped policies isolate one user's credentials from
// another; the owner-stamp trigger sets owner_user_id from auth.uid() on insert; the column grant hides
// token_hash from authenticated; and the resolver — run on the base postgres connection outside any user
// context, as the object owner the grant is revoked for everyone else — yields the owner, defaults and a
// fixed-window throttle verdict only for a live, non-revoked token. Every fixture is seeded through the
// app's own policies and rolled back.
async function checkWebhookCredentialPolicies() {
  console.log("");
  const subject = randomUUID();
  const intruder = randomUUID();

  const labels = [
    "86. an insert without owner_user_id comes back stamped with auth.uid()",
    "87. a second user can neither read, update nor delete another's credential",
    "88. token_hash is unreadable by authenticated while name and defaults read back",
    "89. the resolver yields the owner, defaults and throttled=false for a live token and stamps last_used_at",
    "90. the resolver yields no row for a revoked token and none for an unknown hash",
    "91. the throttle admits calls up to the limit, each throttled=false",
    "92. the over-limit call is throttled=true and is not counted",
    "93. the throttle resets after the window expires and admits again",
  ];
  const tailLabel = "94. the rolled-back webhook credential transaction leaves no trace";

  // 64 hex chars each: the token_hash length check demands exactly that, and the unique index keeps them apart.
  const liveHash = createHash("sha256").update(randomUUID()).digest("hex");
  const throttleHash = createHash("sha256").update(randomUUID()).digest("hex");
  const unknownHash = createHash("sha256").update(randomUUID()).digest("hex");

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject}), (${intruder})`;
      await tx`insert into app_users (id) values (${subject}), (${intruder})`;

      // The resolver executes as the object owner postgres; a helper keeps its four-column read in one place.
      const resolve = (hash: string) =>
        tx<
          {
            owner_user_id: string;
            default_account_id: string | null;
            default_category_id: string | null;
            throttled: boolean;
          }[]
        >`select owner_user_id, default_account_id, default_category_id, throttled
          from private.resolve_webhook_credential(${hash})`;

      await enterUserContext(tx, subject);

      // The defaults the ingest falls back to, both of the subject's own scope.
      const [{ id: account }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${subject}, 'rls webhook cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: category }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${subject}, 'rls webhook category', 'expense') returning id`;

      // 86: the insert names no owner (it is absent from the grant); the trigger stamps it from auth.uid().
      const [live] = await tx<
        { id: string; owner_user_id: string; default_account_id: string | null; default_category_id: string | null }[]
      >`insert into webhook_credentials (name, token_hash, default_account_id, default_category_id)
        values ('rls webhook live', ${liveHash}, ${account}, ${category})
        returning id, owner_user_id, default_account_id, default_category_id`;
      assert(
        labels[0],
        live.owner_user_id === subject,
        `owner_user_id = ${live.owner_user_id === subject ? "subject" : live.owner_user_id}`,
      );

      // A small-window credential the throttle assertions exercise below.
      const [{ id: throttleCred }] = await tx<{ id: string }[]>`
        insert into webhook_credentials (name, token_hash, rate_limit_per_min)
        values ('rls webhook throttle', ${throttleHash}, 3) returning id`;

      // 87: the intruder shares no scope with the subject — the row is invisible and its writes touch nothing.
      await enterUserContext(tx, intruder);
      const [{ count: intruderSees }] = await tx<{ count: string }[]>`
        select count(*)::text as count from webhook_credentials where id = ${live.id}`;
      const intruderUpdate = await tx`update webhook_credentials set name = 'x' where id = ${live.id}`;
      const intruderDelete = await tx`delete from webhook_credentials where id = ${live.id}`;
      assert(
        labels[1],
        intruderSees === "0" && intruderUpdate.count === 0 && intruderDelete.count === 0,
        `visible = ${intruderSees}, update rows = ${intruderUpdate.count}, delete rows = ${intruderDelete.count}`,
      );

      // 88: the SELECT grant lists name and the defaults but never token_hash; reading the hash is denied
      // by the column privilege, even to the owner whose row is otherwise fully visible.
      await enterUserContext(tx, subject);
      const [{ name: readName }] = await tx<{ name: string }[]>`
        select name from webhook_credentials where id = ${live.id}`;
      let hashCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`select token_hash from webhook_credentials where id = ${live.id}`;
        })
        .catch((error: unknown) => {
          hashCode = pgErrorCode(error);
        });
      assert(
        labels[2],
        readName === "rls webhook live" && hashCode === "42501",
        `name = ${readName}, token_hash read sqlstate ${hashCode ?? "none"}`,
      );

      // 89: the resolver, on the base postgres connection, returns the owner, both defaults and a false
      // throttle verdict for the live token, and stamps last_used_at.
      await tx`reset role`;
      const resolvedLive = await resolve(liveHash);
      const [{ stamped }] = await tx<{ stamped: boolean }[]>`
        select last_used_at is not null as stamped from webhook_credentials where id = ${live.id}`;
      assert(
        labels[3],
        resolvedLive.length === 1 &&
          resolvedLive[0].owner_user_id === subject &&
          resolvedLive[0].default_account_id === account &&
          resolvedLive[0].default_category_id === category &&
          resolvedLive[0].throttled === false &&
          stamped === true,
        `rows = ${resolvedLive.length}, owner = ${resolvedLive[0]?.owner_user_id === subject}, account = ${resolvedLive[0]?.default_account_id === account}, category = ${resolvedLive[0]?.default_category_id === category}, throttled = ${resolvedLive[0]?.throttled}, last_used_at set = ${stamped}`,
      );

      // 90: a revoked token and an unknown hash each resolve to nothing — the route maps that to 401.
      await tx`update webhook_credentials set revoked_at = now() where id = ${live.id}`;
      const resolvedRevoked = await resolve(liveHash);
      const resolvedUnknown = await resolve(unknownHash);
      assert(
        labels[4],
        resolvedRevoked.length === 0 && resolvedUnknown.length === 0,
        `revoked rows = ${resolvedRevoked.length}, unknown rows = ${resolvedUnknown.length}`,
      );

      // 91: the fixed window admits every call up to the limit; the limit-th call is still let through.
      const throttleRuns = [
        await resolve(throttleHash),
        await resolve(throttleHash),
        await resolve(throttleHash),
      ];
      assert(
        labels[5],
        throttleRuns.every((run) => run.length === 1 && run[0].throttled === false),
        `throttled verdicts = ${throttleRuns.map((run) => run[0]?.throttled).join(", ")}`,
      );

      // 92: the next call within the window is a valid token but throttled, and it does not raise the count.
      const overLimit = await resolve(throttleHash);
      const [{ rate_count: heldCount }] = await tx<{ rate_count: string }[]>`
        select rate_count::text as rate_count from webhook_credentials where id = ${throttleCred}`;
      assert(
        labels[6],
        overLimit.length === 1 && overLimit[0].throttled === true && heldCount === "3",
        `rows = ${overLimit.length}, throttled = ${overLimit[0]?.throttled}, rate_count = ${heldCount} (expected 3)`,
      );

      // 93: back-dating the window past a minute makes the next call reset it and admit again at count 1.
      await tx`update webhook_credentials set rate_window_started_at = now() - interval '2 minutes'
        where id = ${throttleCred}`;
      const afterReset = await resolve(throttleHash);
      const [{ rate_count: resetCount }] = await tx<{ rate_count: string }[]>`
        select rate_count::text as rate_count from webhook_credentials where id = ${throttleCred}`;
      assert(
        labels[7],
        afterReset.length === 1 && afterReset[0].throttled === false && resetCount === "1",
        `rows = ${afterReset.length}, throttled = ${afterReset[0]?.throttled}, rate_count = ${resetCount} (expected 1)`,
      );

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from webhook_credentials where name like 'rls webhook%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls webhook%' = ${probeCount}`,
  );
}

// Assertions 95-96: the load-bearing security proof. The webhook ingest opens its session by synthesising
// `authenticated` claims from a resolved user id — never a Supabase login. Replicating `withImpersonatedDb`'s
// settle INLINE (the harness cannot nest a `db.transaction`), the same claims key and the same authenticated
// role are set transaction-local. Under that session user A writes A's own account, but a write to user B's
// personal account is refused by the very RLS a browser session obeys. Every fixture is seeded through the
// app's own policies and rolled back.
async function checkImpersonationBounds() {
  console.log("");
  const userA = randomUUID();
  const userB = randomUUID();

  const labels = [
    "95. an impersonated session writes user A's own account and stamps created_by = A",
    "96. an impersonated session is refused on user B's personal account",
  ];
  const tailLabel = "97. the rolled-back impersonation transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${userA}), (${userB})`;
      await tx`insert into app_users (id) values (${userA}), (${userB})`;

      // A's personal account and expense category, seeded under A's own scope.
      await enterUserContext(tx, userA);
      const [{ id: accountA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${userA}, 'rls impersonation A cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: categoryA }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${userA}, 'rls impersonation A expense', 'expense') returning id`;

      // B's personal account, seeded under B's own scope. No group ties A to B, so A holds no write over it.
      await tx`reset role`;
      await enterUserContext(tx, userB);
      const [{ id: accountB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${userB}, 'rls impersonation B cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;

      // Synthesise A's authenticated claims inline, exactly as `withImpersonatedDb` does: the claims key
      // built with json_build_object and the authenticated role, both transaction-local. This is the
      // webhook ingest's session — a resolved user id, never a request payload — and it must obey RLS.
      await tx`reset role`;
      await tx`select
        set_config('request.jwt.claims',
          json_build_object('sub', ${userA}::text, 'role', 'authenticated', 'aud', 'authenticated')::text, true),
        set_config('statement_timeout', '8000', true),
        set_config('role', 'authenticated', true)`;

      // 95: the impersonated session writes A's own account — a movement row plus its one split, the ledger's
      // insert shape replicated inline. The scope trigger stamps created_by from the synthesised claims.
      const [ownWrite] = await tx<{ id: string; created_by: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${accountA}, 5000, (now() at time zone 'America/Bogota')::date)
        returning id, created_by`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${ownWrite.id}, ${categoryA}, 5000)`;
      assert(
        labels[0],
        ownWrite.created_by === userA,
        `created_by = ${ownWrite.created_by === userA ? "A" : ownWrite.created_by}`,
      );

      // 96: the same session may not touch B's personal account — can_write_transaction refuses it with
      // 42501, proving the synthesised-claims path is bounded by the exact RLS a login is.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into transactions (from_account_id, amount_cents, occurred_at)
            values (${accountB}, 5000, (now() at time zone 'America/Bogota')::date)`;
          assert(labels[1], false, "the impersonated session wrote B's account, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "42501", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // Unwind the impersonated role before the rollback probe.
      await tx`reset role`;

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls impersonation%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls impersonation%' = ${probeCount}`,
  );
}

// Assertions 98-102: the invite claim (RF-06). A group carries a pending member — `user_id` null,
// `invite_email` set — that the invited person claims once their magic link proves that email. The
// claim policy admits exactly the caller whose `auth.email()` matches the row's `invite_email`, setting
// `user_id` to their own sub and clearing the invite; a different email is filtered out, and a caller
// who already holds a live membership is stopped by the one-group index. Every fixture rolls back.
async function checkInviteClaimPolicies() {
  console.log("");
  const leaderUser = randomUUID();
  const invitedUser = randomUUID();
  const strangerUser = randomUUID();
  const busyUser = randomUUID();

  const invitedEmail = `invited-${randomUUID()}@example.test`;
  const busyEmail = `busy-${randomUUID()}@example.test`;
  const strangerEmail = `stranger-${randomUUID()}@example.test`;

  const groupId = randomUUID();
  const busyGroupId = randomUUID();

  const labels = [
    "98. the invited caller's sign-in claims nothing: the pending row stays pending, unseen and unclaimed (RF-154)",
    "99. a caller whose email does not match the invite claims nothing",
    "100. accepting an invitation puts a caller who already holds a live membership in a second: the one-group index refuses it",
    "101. row security stays enabled and forced on group_members",
  ];
  const tailLabel = "102. the rolled-back invite transaction leaves no trace";

  // 101: read the flags outside any transaction, so FORCE is proved on the committed catalog, not a local edit.
  const [gmRel] = await sql<{ rowsecurity: boolean; forced: boolean }[]>`
    select relrowsecurity as rowsecurity, relforcerowsecurity as forced
    from pg_class where oid = 'finances.group_members'::regclass`;
  assert(
    labels[3],
    gmRel.rowsecurity === true && gmRel.forced === true,
    `relrowsecurity = ${gmRel.rowsecurity}, relforcerowsecurity = ${gmRel.forced}`,
  );

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser}), (${invitedUser}), (${strangerUser}), (${busyUser})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${invitedUser}), (${strangerUser}), (${busyUser})`;

      // The target group and its leader, plus two pending members the leader records (RF-07): one invite
      // waits on the plain invited caller, the other on the caller who already leads a group of their own.
      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls invite', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls invite leader', 'leader')`;
      const [{ id: pendingInvited }] = await tx<{ id: string }[]>`
        insert into group_members (group_id, name, role, invite_email)
        values (${groupId}, 'rls invite pending', 'member', ${invitedEmail}) returning id`;
      await tx`insert into group_members (group_id, name, role, invite_email)
        values (${groupId}, 'rls invite pending busy', 'member', ${busyEmail})`;

      // The busy caller leads a group of their own: a live membership that blocks any second claim.
      await tx`reset role`;
      await enterUserContext(tx, busyUser, busyEmail);
      await tx`insert into groups (id, name, cash_mode) values (${busyGroupId}, 'rls invite busy', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${busyGroupId}, ${busyUser}, 'rls invite busy leader', 'leader')`;

      // 98: the invited caller claims their own pending row. The SELECT policy still hides an unclaimed
      // row from the outsider, so the caller could not name it even if the claim took a target; it takes
      // none, and picks the row addressed to the email their magic link proved.
      await tx`reset role`;
      await enterUserContext(tx, invitedUser, invitedEmail);
      const [{ count: preClaimVisible }] = await tx<{ count: string }[]>`
        select count(*)::text as count from group_members where id = ${pendingInvited}`;
      const [{ claim_group_invite: claimedId }] = await tx<
        { claim_group_invite: string | null }[]
      >`select private.claim_group_invite()`;
      const [claimed] = await tx<{ user_id: string | null; invite_email: string | null; role: string }[]>`
        select user_id, invite_email, role from group_members where id = ${pendingInvited}`;
      assert(
        labels[0],
        preClaimVisible === "0" &&
          claimedId === null &&
          claimed === undefined,
        `pre-claim visible = ${preClaimVisible}, claim returned ${claimedId ?? "null"}, row visible to the caller = ${claimed ? "yes" : "no"}`,
      );

      // 99: a caller whose email matches no invite claims nothing — the function matches on auth.email()
      // alone, so there is no row for it to pick.
      await tx`reset role`;
      await enterUserContext(tx, strangerUser, strangerEmail);
      const [{ claim_group_invite: strangerId }] = await tx<
        { claim_group_invite: string | null }[]
      >`select private.claim_group_invite()`;
      assert(labels[1], strangerId === null, `returned ${strangerId ?? "null"}`);

      // 100: the busy caller's email matches the invite, so the function picks the pending row; the
      // one-group-per-user index then refuses it, since the caller already holds a live membership.
      await tx`reset role`;
      await tx
        .savepoint(async (sp) => {
          await sp`update group_members set user_id = ${busyUser}, invite_email = null, invite_state = 'accepted'
            where group_id = ${groupId} and lower(invite_email) = lower(${busyEmail})`;
          assert(labels[2], false, "a second live membership landed, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[2], pgErrorCode(error) === "23505", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls invite%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls invite%' = ${probeCount}`,
  );
}

// Assertions 105-108: the recurring rules and their in-DB generator. Read is universal inside the group
// and closed to an outsider; write is bounded to own-or-shared accounts and the scope is the trigger's,
// not the caller's; and `private.run_due_recurring_rules()`, run with no JWT like the daily cron, back-fills
// one unreviewed single-split transaction per missed period and advances the rule. Every fixture is seeded
// through the app's own policies and rolled back.
async function checkRecurringRulePolicies() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const intruderUser = randomUUID();
  const groupId = randomUUID();
  const intruderGroup = randomUUID();

  const labels = [
    "105. a member reads their own personal rule and the group's rule while an outsider reads neither",
    "106. a rule naming an account outside the caller's writable scope is refused",
    "107. a rule on an own account lands with the trigger's derived scope, not a supplied one",
    "108. the generator back-fills one unreviewed single-split transaction per missed period and advances the rule",
    "109. the member stamps reviewed_at on their generated row and it drops the unreviewed predicate; an outsider cannot",
  ];
  const tailLabel = "110. the rolled-back recurring rule transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser}), (${intruderUser})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser}), (${intruderUser})`;

      // The group, its leader, a personal leader account, a shared group account and a group expense category.
      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls recurring', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls recurring leader', 'leader')`;
      const [{ id: leaderAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls recurring leader cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: sharedAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${groupId}, true, 'rls recurring shared cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: groupExpenseCat }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${groupId}, 'rls recurring group expense', 'expense') returning id`;

      // A group-scoped rule on the shared account, due only in the future so the generator leaves it be.
      const [{ id: groupRule }] = await tx<{ id: string }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on)
        values (${sharedAccount}, 6000, ${groupExpenseCat}, 'monthly', 1, 15,
          (now() at time zone 'America/Bogota')::date + 30) returning id`;

      // The plain member with their own account and expense category, seeded through their own context.
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls recurring member', 'member')`;
      await enterUserContext(tx, memberUser);
      // Opened the day 108's overdue rule first falls due, so every period it back-fills postdates the opening (RF-162).
      const [{ id: memberAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${memberUser}, 'rls recurring member cash', 'asset', (now() at time zone 'America/Bogota')::date - 21) returning id`;
      const [{ id: memberExpenseCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${memberUser}, 'rls recurring member expense', 'expense') returning id`;

      // 107: a rule on the member's own account lands personal, its scope and author the trigger's, not supplied.
      const [personalRule] = await tx<
        { id: string; owner_user_id: string | null; group_id: string | null; created_by: string }[]
      >`insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on)
        values (${memberAccount}, 5000, ${memberExpenseCat}, 'monthly', 1, 15,
          (now() at time zone 'America/Bogota')::date + 30)
        returning id, owner_user_id, group_id, created_by`;
      assert(
        labels[2],
        personalRule.owner_user_id === memberUser &&
          personalRule.group_id === null &&
          personalRule.created_by === memberUser,
        `owner = ${personalRule.owner_user_id === memberUser ? "self" : personalRule.owner_user_id}, group = ${personalRule.group_id}, created_by = ${personalRule.created_by === memberUser}`,
      );

      // 106: the bounded write — the member may not book a rule out of the leader's personal account.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on)
            values (${leaderAccount}, 5000, ${memberExpenseCat}, 'monthly', 1, 15,
              (now() at time zone 'America/Bogota')::date + 30)`;
          assert(labels[1], false, "a rule on another's account stood, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "42501", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // An outsider who leads a group of their own and shares nothing with the member.
      await tx`reset role`;
      await enterUserContext(tx, intruderUser);
      await tx`insert into groups (id, name, cash_mode) values (${intruderGroup}, 'rls recurring intruder', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${intruderGroup}, ${intruderUser}, 'rls recurring intruder leader', 'leader')`;

      // 105: universal read inside the group, closed outside it.
      const [{ count: outsiderSeesPersonal }] = await tx<{ count: string }[]>`
        select count(*)::text as count from recurring_rules where id = ${personalRule.id}`;
      const [{ count: outsiderSeesGroup }] = await tx<{ count: string }[]>`
        select count(*)::text as count from recurring_rules where id = ${groupRule}`;
      await enterUserContext(tx, memberUser);
      const [{ count: memberSeesPersonal }] = await tx<{ count: string }[]>`
        select count(*)::text as count from recurring_rules where id = ${personalRule.id}`;
      const [{ count: memberSeesGroup }] = await tx<{ count: string }[]>`
        select count(*)::text as count from recurring_rules where id = ${groupRule}`;
      assert(
        labels[0],
        memberSeesPersonal === "1" &&
          memberSeesGroup === "1" &&
          outsiderSeesPersonal === "0" &&
          outsiderSeesGroup === "0",
        `member→own = ${memberSeesPersonal}, member→group = ${memberSeesGroup}, outsider→own = ${outsiderSeesPersonal}, outsider→group = ${outsiderSeesGroup}`,
      );

      // 108: a weekly rule three weeks overdue, generated with no JWT the way the daily cron runs it.
      const [{ id: dueRule }] = await tx<{ id: string }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on)
        values (${memberAccount}, 4000, ${memberExpenseCat}, 'weekly', 1,
          (now() at time zone 'America/Bogota')::date - 21) returning id`;

      // The generator runs as the owner with the JWT claims cleared, so `auth.uid()` is null like the cron's.
      await tx`reset role`;
      await tx`select set_config('request.jwt.claims', '', true)`;
      await tx`select private.run_due_recurring_rules()`;
      // Force the deferred split-sum triggers now, proving every generated movement balances its one split.
      await tx`set constraints all immediate`;

      const generated = await tx<
        { id: string; occurred_at: string; recurring_rule_id: string | null; reviewed_at: string | null; splits: string }[]
      >`
        select t.id, t.occurred_at::text as occurred_at, t.recurring_rule_id, t.reviewed_at,
          (select count(*)::text from transaction_splits s where s.transaction_id = t.id) as splits
        from transactions t
        where t.recurring_rule_id = ${dueRule}
        order by t.occurred_at`;
      const [{ expected }] = await tx<{ expected: string[] }[]>`
        select array[
          ((now() at time zone 'America/Bogota')::date - 21)::text,
          ((now() at time zone 'America/Bogota')::date - 14)::text,
          ((now() at time zone 'America/Bogota')::date - 7)::text,
          ((now() at time zone 'America/Bogota')::date)::text
        ] as expected`;
      const [{ count: unreviewed }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions
        where recurring_rule_id = ${dueRule} and recurring_rule_id is not null and reviewed_at is null`;
      const [advanced] = await tx<{ next_run_on: string; is_active: boolean }[]>`
        select next_run_on::text, is_active from recurring_rules where id = ${dueRule}`;
      const [{ next_expected: nextExpected }] = await tx<{ next_expected: string }[]>`
        select ((now() at time zone 'America/Bogota')::date + 7)::text as next_expected`;

      const datesMatch =
        generated.length === expected.length &&
        generated.every((row, i) => row.occurred_at === expected[i]);
      const allMarked = generated.every(
        (row) => row.recurring_rule_id === dueRule && row.reviewed_at === null && row.splits === "1",
      );
      assert(
        labels[3],
        datesMatch &&
          allMarked &&
          unreviewed === String(expected.length) &&
          advanced.next_run_on === nextExpected &&
          advanced.is_active === true,
        `generated = ${generated.length} (expected ${expected.length}), dates match = ${datesMatch}, each marked+single-split = ${allMarked}, unreviewed = ${unreviewed}, next_run_on advanced = ${advanced.next_run_on === nextExpected}, is_active = ${advanced.is_active}`,
      );

      // 109: the review write. The row is the member's own, so as `authenticated` they stamp reviewed_at
      // through the new column grant and it leaves the unreviewed set; the outsider's write is barred by RLS.
      const reviewTarget = generated[0].id;
      await enterUserContext(tx, memberUser);
      const memberReview = await tx`update transactions set reviewed_at = now() where id = ${reviewTarget}`;
      const [{ count: stillUnreviewed }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions
        where recurring_rule_id = ${dueRule} and recurring_rule_id is not null and reviewed_at is null`;
      await enterUserContext(tx, intruderUser);
      const outsiderReview = await tx`update transactions set reviewed_at = now() where id = ${reviewTarget}`;
      assert(
        labels[4],
        memberReview.count === 1 &&
          stillUnreviewed === String(expected.length - 1) &&
          outsiderReview.count === 0,
        `member review rows = ${memberReview.count}, remaining unreviewed = ${stillUnreviewed} (expected ${expected.length - 1}), outsider review rows = ${outsiderReview.count}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls recurring%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls recurring%' = ${probeCount}`,
  );
}

// Assertions 111-116: the audit log. The definer trigger captures every write on an audited table
// (RF-43); the log itself is locked to every user role, readable and writable by none (RF-44); the
// recurring generator's own writes are captured with a null actor, marking a system write (RF-45); no
// RLS-enabled table save the log escapes the trigger (RF-45); and the daily purge drops rows past the
// 24-month horizon while sparing the recent (RNF-14). Fixtures roll back with their transaction.
async function checkAuditLogPolicies() {
  console.log("");
  const subject = randomUUID();

  const labels = [
    "111. an authenticated insert, update and delete of a category each land one audit row with the right action, before/after and the caller as actor",
    "112. an authenticated insert, update and delete against the log are each refused",
    "113. the recurring generator's transaction and its split are captured with a null actor",
    "114. every RLS-enabled table save the log carries the capture trigger",
    "115. the purge drops a row past 24 months and keeps a recent one",
  ];
  const tailLabel = "116. the rolled-back audit transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject})`;
      await tx`insert into app_users (id) values (${subject})`;

      // 111: the caller's own category, changed then removed; the definer trigger lands one row per op.
      await enterUserContext(tx, subject);
      const [{ id: catId }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${subject}, 'rls audit category', 'expense') returning id`;
      await tx`update categories set name = 'rls audit category renamed' where id = ${catId}`;
      await tx`delete from categories where id = ${catId}`;

      await tx`reset role`;
      const capRows = await tx<
        { action: string; actor_user_id: string | null; before_null: boolean; after_null: boolean }[]
      >`select action, actor_user_id, before_data is null as before_null, after_data is null as after_null
        from audit_log where entity = 'categories' and record_id = ${catId} order by id`;
      const capOk =
        capRows.length === 3 &&
        capRows[0].action === "INSERT" && capRows[0].before_null && !capRows[0].after_null &&
        capRows[1].action === "UPDATE" && !capRows[1].before_null && !capRows[1].after_null &&
        capRows[2].action === "DELETE" && !capRows[2].before_null && capRows[2].after_null &&
        capRows.every((row) => row.actor_user_id === subject);
      assert(
        labels[0],
        capOk,
        `rows = ${capRows.length}, actions = ${capRows.map((r) => r.action).join(",")}, actor = ${capRows.every((r) => r.actor_user_id === subject) ? "caller" : "other"}`,
      );

      // 112: the log grants no write to any user role (RF-44), so each direct mutation is denied (42501).
      // SELECT is now the sole user privilege — its bound is proved in checkAuditViewerPolicy below.
      await enterUserContext(tx, subject);
      const barred = { insert: "", update: "", delete: "" };
      await tx
        .savepoint(async (sp) => {
          await sp`insert into audit_log (entity, record_id, action) values ('categories', ${catId}, 'INSERT')`;
        })
        .catch((error: unknown) => {
          barred.insert = pgErrorCode(error) ?? "none";
        });
      await tx
        .savepoint(async (sp) => {
          await sp`update audit_log set action = 'DELETE' where entity = 'categories'`;
        })
        .catch((error: unknown) => {
          barred.update = pgErrorCode(error) ?? "none";
        });
      await tx
        .savepoint(async (sp) => {
          await sp`delete from audit_log where entity = 'categories'`;
        })
        .catch((error: unknown) => {
          barred.delete = pgErrorCode(error) ?? "none";
        });
      assert(
        labels[1],
        barred.insert === "42501" && barred.update === "42501" && barred.delete === "42501",
        `insert = ${barred.insert}, update = ${barred.update}, delete = ${barred.delete}`,
      );

      // 113: a rule one period overdue, generated with the JWT cleared the way the daily cron runs it.
      // Both the movement and its split are captured with a null actor — the mark of a system write.
      await enterUserContext(tx, subject);
      const [{ id: dueAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${subject}, 'rls audit account', 'asset', (now() at time zone 'America/Bogota')::date - 7) returning id`;
      const [{ id: dueCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${subject}, 'rls audit expense', 'expense') returning id`;
      const [{ id: dueRule }] = await tx<{ id: string }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on)
        values (${dueAccount}, 4000, ${dueCat}, 'weekly', 1, (now() at time zone 'America/Bogota')::date - 7) returning id`;

      await tx`reset role`;
      await tx`select set_config('request.jwt.claims', '', true)`;
      await tx`select private.run_due_recurring_rules()`;
      await tx`set constraints all immediate`;

      const [{ id: genTxn }] = await tx<{ id: string }[]>`
        select id from transactions where recurring_rule_id = ${dueRule} limit 1`;
      const [{ id: genSplit }] = await tx<{ id: string }[]>`
        select id from transaction_splits where transaction_id = ${genTxn} limit 1`;
      const [txnAudit] = await tx<{ actor_user_id: string | null }[]>`
        select actor_user_id from audit_log where entity = 'transactions' and record_id = ${genTxn}`;
      const [splitAudit] = await tx<{ actor_user_id: string | null }[]>`
        select actor_user_id from audit_log where entity = 'transaction_splits' and record_id = ${genSplit}`;
      assert(
        labels[2],
        txnAudit?.actor_user_id === null && splitAudit?.actor_user_id === null,
        `transaction actor = ${txnAudit?.actor_user_id ?? "null"}, split actor = ${splitAudit?.actor_user_id ?? "null"}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // 114: no audited write path skips capture — every RLS-enabled public table but the log itself
  // carries a `capture_audit` trigger. The allowed list and the sign-in counter hold no fund data and no
  // scope, and no API role can write either, so they are exempt. Runs outside any role switch; it reads
  // only the catalog.
  const uncovered = await sql<{ tablename: string }[]>`
    select c.relname as tablename
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'finances' and c.relkind = 'r' and c.relrowsecurity
      and c.relname <> 'audit_log'
      and not exists (
        select 1 from pg_trigger t
        where t.tgrelid = c.oid and t.tgname = 'capture_audit' and not t.tgisinternal)`;
  assert(
    labels[3],
    uncovered.length === 0,
    `RLS tables missing the trigger = ${uncovered.length}${uncovered.length ? " (" + uncovered.map((r) => r.tablename).join(", ") + ")" : ""}`,
  );

  // 115: the purge is age-bounded. Seed one row past the horizon and one fresh, purge, and read back.
  await sql
    .begin(async (tx) => {
      const agedId = randomUUID();
      const freshId = randomUUID();
      await tx`insert into audit_log (entity, record_id, action, occurred_at)
        values ('categories', ${agedId}, 'INSERT', now() - interval '25 months')`;
      await tx`insert into audit_log (entity, record_id, action, occurred_at)
        values ('categories', ${freshId}, 'INSERT', now())`;
      await tx`select private.purge_audit_log()`;
      const [{ count: agedLeft }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log where record_id = ${agedId}`;
      const [{ count: freshLeft }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log where record_id = ${freshId}`;
      assert(
        labels[4],
        agedLeft === "0" && freshLeft === "1",
        `aged rows left = ${agedLeft} (expected 0), recent rows left = ${freshLeft} (expected 1)`,
      );
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from categories where name like 'rls audit%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls audit%' = ${probeCount}`,
  );
}

// Assertions 129-132: the read-only audit viewer (RF-53). The 0010 policy admits three kinds of row —
// one scoped to the reader personally, one scoped to a group they belong to, and one they themselves
// caused (the last surfaces the unscoped child rows to their actor alone) — and nothing else. A row of
// another user's personal scope or caused only by them stays hidden. The write ban (RF-44) holds: the
// reader's own INSERT, UPDATE and DELETE on the log are each refused. Fixtures roll back.
async function checkAuditViewerPolicy() {
  console.log("");
  const readerUser = randomUUID();
  const strangerUser = randomUUID();
  const groupId = randomUUID();

  const labels = [
    "129. the reader sees its own-scope row, its group-scope row and the unscoped row it caused",
    "130. the reader sees neither a stranger's personal-scope row nor the unscoped row the stranger caused",
    "131. the reader's insert, update and delete against the log are each refused",
  ];
  const tailLabel = "132. the rolled-back audit-viewer transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${readerUser}), (${strangerUser})`;
      await tx`insert into app_users (id) values (${readerUser}), (${strangerUser})`;

      // The reader, its group and its leadership: the personal category stamps an owner-scoped audit row,
      // the group category a group-scoped one, and the income's split an unscoped one the reader caused.
      await enterUserContext(tx, readerUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls audit viewer', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${readerUser}, 'rls audit viewer reader', 'leader')`;
      const [{ id: readerCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${readerUser}, 'rls audit viewer personal', 'expense') returning id`;
      const [{ id: readerGroupCat }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${groupId}, 'rls audit viewer group', 'expense') returning id`;
      const [{ id: readerAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${readerUser}, 'rls audit viewer cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: readerIncomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${readerUser}, 'rls audit viewer income', 'income') returning id`;
      const [{ id: readerTxn }] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at)
        values (${readerAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: readerSplit }] = await tx<{ id: string }[]>`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${readerTxn}, ${readerIncomeCat}, 5000) returning id`;

      // The stranger, in a scope of their own and no shared group: a personal category and the split of
      // their own income — an owner-scoped row and an unscoped row the stranger, not the reader, caused.
      await enterUserContext(tx, strangerUser);
      const [{ id: strangerCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${strangerUser}, 'rls audit viewer stranger', 'expense') returning id`;
      const [{ id: strangerAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${strangerUser}, 'rls audit viewer stranger cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: strangerIncomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${strangerUser}, 'rls audit viewer stranger income', 'income') returning id`;
      const [{ id: strangerTxn }] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at)
        values (${strangerAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: strangerSplit }] = await tx<{ id: string }[]>`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${strangerTxn}, ${strangerIncomeCat}, 5000) returning id`;

      // 129: back under the reader, each branch of the predicate yields its row.
      await enterUserContext(tx, readerUser);
      const [{ count: ownScope }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log where entity = 'categories' and record_id = ${readerCat}`;
      const [{ count: groupScope }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log where entity = 'categories' and record_id = ${readerGroupCat}`;
      const [{ count: selfCaused }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log where entity = 'transaction_splits' and record_id = ${readerSplit}`;
      assert(
        labels[0],
        ownScope === "1" && groupScope === "1" && selfCaused === "1",
        `own-scope = ${ownScope}, group-scope = ${groupScope}, self-caused unscoped = ${selfCaused}`,
      );

      // 130: no branch reaches the stranger's personal row or the unscoped row only the stranger caused.
      const [{ count: strangerScope }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log where entity = 'categories' and record_id = ${strangerCat}`;
      const [{ count: strangerCaused }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log where entity = 'transaction_splits' and record_id = ${strangerSplit}`;
      assert(
        labels[1],
        strangerScope === "0" && strangerCaused === "0",
        `stranger personal-scope = ${strangerScope}, stranger-caused unscoped = ${strangerCaused}`,
      );

      // 131: the viewer grant is SELECT only (RF-44) — every direct mutation is still denied (42501).
      const barred = { insert: "", update: "", delete: "" };
      await tx
        .savepoint(async (sp) => {
          await sp`insert into audit_log (entity, record_id, action) values ('categories', ${readerCat}, 'INSERT')`;
        })
        .catch((error: unknown) => {
          barred.insert = pgErrorCode(error) ?? "none";
        });
      await tx
        .savepoint(async (sp) => {
          await sp`update audit_log set action = 'DELETE' where record_id = ${readerCat}`;
        })
        .catch((error: unknown) => {
          barred.update = pgErrorCode(error) ?? "none";
        });
      await tx
        .savepoint(async (sp) => {
          await sp`delete from audit_log where record_id = ${readerCat}`;
        })
        .catch((error: unknown) => {
          barred.delete = pgErrorCode(error) ?? "none";
        });
      assert(
        labels[2],
        barred.insert === "42501" && barred.update === "42501" && barred.delete === "42501",
        `insert = ${barred.insert}, update = ${barred.update}, delete = ${barred.delete}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name = 'rls audit viewer'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls audit viewer' = ${probeCount}`,
  );
}

// Assertions 117-122: the durable account `subtype` (RF-56), in the words 0059 stores. The 0009
// backfill classified every row, and 0059 spelled the words `bank`, `cash`, `card` — seeded cash to
// 'cash', any other liability to 'card', any other asset to 'bank' —
// and no row is left null; the subtype↔kind CHECK refuses a mismatch; the derive trigger fills an
// omitted subtype while the column grant lets a member pass and later change one; and the widened
// column changed no read policy, so a non-member still cannot SELECT another group's cash account.
// Fixtures roll back.
async function checkAccountSubtypeBackfill() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const outsiderUser = randomUUID();
  const groupId = randomUUID();

  const labels = [
    "117. the stored words after 0059 hold: a seeded cash account is 'cash', a card 'card', a bank 'bank'",
    "118. no accounts row across the whole table carries a null subtype",
    "119. the subtype↔kind check refuses a liability marked cash — the one subtype the trigger keeps",
    "120. the derive trigger fills the caller-ungranted column, so an authenticated insert omitting subtype lands",
    "121. a non-member cannot SELECT another group's cash account — the widened column changed no read policy",
    "122. the column grant lets a member insert an explicit cash and later change it to bank; a cash liability is still refused",
  ];
  const tailLabel = "123. the rolled-back subtype transaction leaves no trace";

  // The exact CASE the 0009 backfill applied, replicated so the proof reads what the migration ran.
  const backfillSubtype = (name: string, kind: string) =>
    ["Efectivo del grupo", "Group cash", "Mi efectivo", "My cash"].includes(name)
      ? "cash"
      : kind === "liability"
        ? "card"
        : "bank";

  const forcedRollback = Symbol("forced rollback");

  // 118: a table-wide read outside any role switch — the applied migration left every existing row set.
  const [{ count: nullCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where subtype is null`;

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser}), (${outsiderUser})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser}), (${outsiderUser})`;

      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls subtype', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls subtype leader', 'leader')`;

      // The group's shared cash account. `cash` carries no INSERT grant, so it is seeded as the owner
      // with the value the backfill would have written, exactly as a renamed-free seeded cash row holds it.
      await tx`reset role`;
      const cashName = GROUP_CASH_ACCOUNT_NAME.es;
      const [{ id: cashAccount, subtype: cashSubtype }] = await tx<{ id: string; subtype: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, subtype, initial_balance_on)
        values (${groupId}, true, ${cashName}, 'asset', 'cash', (now() at time zone 'America/Bogota')::date)
        returning id, subtype`;

      // A card and a bank, seeded through the leader's own context omitting subtype: the derive trigger
      // sets 'card' for the liability and 'bank' for the asset — the backfill's other two outcomes.
      await enterUserContext(tx, leaderUser);
      const [{ subtype: cardSubtype }] = await tx<{ subtype: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${leaderUser}, 'rls subtype leader card', 'liability', -100000, (now() at time zone 'America/Bogota')::date)
        returning subtype`;
      const [{ subtype: bankSubtype }] = await tx<{ subtype: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls subtype leader bank', 'asset', (now() at time zone 'America/Bogota')::date)
        returning subtype`;

      assert(
        labels[0],
        cashSubtype === backfillSubtype(cashName, "asset") &&
          cardSubtype === backfillSubtype("rls subtype leader card", "liability") &&
          bankSubtype === backfillSubtype("rls subtype leader bank", "asset") &&
          cashSubtype === "cash" && cardSubtype === "card" && bankSubtype === "bank",
        `cash = ${cashSubtype}, card = ${cardSubtype}, bank = ${bankSubtype}`,
      );

      assert(labels[1], nullCount === "0", `rows with a null subtype = ${nullCount}`);

      // 119: the subtype↔kind check. The trigger rewrites any non-'cash' value to follow the kind,
      // so 'cash' is the sole value it preserves — and 'cash' on a liability is what the CHECK
      // must reject. Seeded as the owner so the explicit value reaches the row untouched.
      let checkBreach = "";
      await tx
        .savepoint(async (sp) => {
          await sp`reset role`;
          await sp`insert into accounts (owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
            values (${leaderUser}, 'rls subtype cash card', 'liability', 'cash', -100, (now() at time zone 'America/Bogota')::date)`;
          assert(labels[2], false, "a cash liability landed, which the check must not allow");
        })
        .catch((error: unknown) => {
          checkBreach = pgErrorCode(error) ?? "none";
          assert(labels[2], checkBreach === "23514", `sqlstate ${checkBreach}`);
        });

      // 120: the derive trigger already carried the two inserts above; assert both landed non-null.
      assert(
        labels[3],
        cardSubtype !== null && bankSubtype !== null,
        `authenticated insert filled card = ${cardSubtype}, bank = ${bankSubtype}`,
      );

      // 121: an outsider in no shared group sees zero rows for the group's cash account.
      await enterUserContext(tx, outsiderUser);
      const [{ count: outsiderSees }] = await tx<{ count: string }[]>`
        select count(*)::text as count from accounts where id = ${cashAccount}`;
      assert(labels[4], outsiderSees === "0", `visible rows = ${outsiderSees}`);

      // 122: the column grant, exercised as an authenticated member in scope. A member creates a cash
      // account by passing 'cash' — the trigger keeps the explicit value — then changes it to
      // 'bank'; but a 'cash' on a liability is still barred by the subtype↔kind CHECK.
      await enterUserContext(tx, memberUser);
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls subtype member', 'member')`;
      await enterUserContext(tx, memberUser);
      const [{ subtype: pickedSubtype, id: pickedAccount }] = await tx<{ subtype: string; id: string }[]>`
        insert into accounts (owner_user_id, name, kind, subtype, initial_balance_on)
        values (${memberUser}, 'rls subtype member cash', 'asset', 'cash', (now() at time zone 'America/Bogota')::date)
        returning subtype, id`;
      const changed = await tx`update accounts set subtype = 'bank' where id = ${pickedAccount}`;
      const [{ subtype: changedSubtype }] = await tx<{ subtype: string }[]>`
        select subtype from accounts where id = ${pickedAccount}`;
      let liabilityBreach = "";
      await tx
        .savepoint(async (sp) => {
          await sp`insert into accounts (owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
            values (${memberUser}, 'rls subtype member card', 'liability', 'cash', -100, (now() at time zone 'America/Bogota')::date)`;
        })
        .catch((error: unknown) => {
          liabilityBreach = pgErrorCode(error) ?? "none";
        });
      assert(
        labels[5],
        pickedSubtype === "cash" && changed.count === 1 && changedSubtype === "bank" &&
          liabilityBreach === "23514",
        `inserted = ${pickedSubtype}, updated rows = ${changed.count}, now = ${changedSubtype}, cash-liability sqlstate = ${liabilityBreach}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls subtype%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls subtype%' = ${probeCount}`,
  );
}

// Assertions 124-127: the cash slice's report invariants. A withdrawal is a transfer bank→cash — the
// member's contribution, settled on the way in; a cash expense flows out of the group's `cash`
// account; a return is a transfer cash→bank that debits the contribution. What is proved is that the
// two transfers never leak into income or expense (RF-40, RF-19), that the return nets down the
// contribution (RF-42, RF-66), and that handing cash writes no row (RF-41). The very aggregate SQL of
// the three report queries is replicated inside the transaction, never the query functions themselves
// (they open their own `withUserDb`). Every fixture is seeded through the app's own policies and rolled back.
async function checkCashReportInvariants() {
  console.log("");
  const memberUser = randomUUID();
  const groupId = randomUUID();

  const labels = [
    "124. the withdrawal and the return are transfers — the flow window's expense is the cash expense alone (6000), income 0",
    "125. expenses-by-category totals the cash expense's one split and no transfer — 6000 in the one category",
    "126. the return debits the member's contribution: net = withdrawal − return = 7000, not 10000",
    "127. no row records the physical hand-off — the withdrawal, the cash expense and the return are the only three movements",
  ];
  const tailLabel = "128. the rolled-back cash-report transaction leaves no trace";

  // The exact aggregate SQL of the flow and category report queries, replicated so the proof reads what ships.
  const flowSums = (q: postgres.TransactionSql, start: string, endExclusive: string) =>
    q<{ income_cents: string; expense_cents: string }[]>`
      select
        coalesce(sum(amount_cents) filter (where kind = 'income'), 0) as income_cents,
        coalesce(sum(amount_cents) filter (where kind = 'expense'), 0) as expense_cents
      from transactions
      where occurred_at >= ${start} and occurred_at < ${endExclusive}`;

  const categoryTotals = (q: postgres.TransactionSql, start: string, endExclusive: string) =>
    q<{ category_id: string; total_cents: string }[]>`
      select s.category_id, c.name, c.color, sum(s.amount_cents) as total_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join categories c on c.id = s.category_id
      where t.kind = 'expense'
        and t.occurred_at >= ${start} and t.occurred_at < ${endExclusive}
      group by s.category_id, c.name, c.color
      order by sum(s.amount_cents) desc`;

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      // One identity, its group and its leadership, seeded as the owner before any role switch.
      await tx`insert into auth.users (id) values (${memberUser})`;
      await tx`insert into app_users (id) values (${memberUser})`;

      await enterUserContext(tx, memberUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls cash report', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls cash report member', 'leader')`;

      // Mirrors `currentMonthRange()`: the first of the current Bogotá month and the first of the next.
      const [{ start: winStart, end_exclusive: winEnd }] = await tx<
        { start: string; end_exclusive: string }[]
      >`select
          to_char(date_trunc('month', now() at time zone 'America/Bogota'), 'YYYY-MM-DD') as start,
          to_char(date_trunc('month', now() at time zone 'America/Bogota') + interval '1 month', 'YYYY-MM-DD') as end_exclusive`;

      // The member's personal bank account, the group's shared `cash` account and one group expense
      // category. `cash` carries no INSERT grant, so the cash row is seeded as the owner with the
      // subtype a seeded cash account holds, exactly as the fund's own does.
      const [{ id: bankAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${memberUser}, 'rls cash report bank', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`reset role`;
      const cashName = GROUP_CASH_ACCOUNT_NAME.es;
      const [{ id: cashAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, subtype, initial_balance_on)
        values (${groupId}, true, ${cashName}, 'asset', 'cash', (now() at time zone 'America/Bogota')::date) returning id`;
      await enterUserContext(tx, memberUser);
      const [{ id: expenseCat }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${groupId}, 'rls cash report groceries', 'expense') returning id`;

      // 1. Withdrawal: a transfer bank→cash of 10000 — the contribution, settled on the way in (FLOWS §4).
      const [{ id: withdrawalTxn }] = await tx<{ id: string; kind: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${bankAccount}, ${cashAccount}, 10000, (now() at time zone 'America/Bogota')::date)
        returning id, kind`;

      // 2. Cash expense: 6000 out of the group `cash`, one split on the group category.
      const [{ id: expenseTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${cashAccount}, 6000, (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${expenseTxn}, ${expenseCat}, 6000)`;

      // 3. Return: a transfer cash→bank of 3000 — debits the member's contribution (RF-42).
      const [{ id: returnTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${cashAccount}, ${bankAccount}, 3000, (now() at time zone 'America/Bogota')::date) returning id`;

      // 124 (RF-40, RF-19): the flow window sums the cash expense alone. The two transfers count in
      // neither total — the expense is 6000, never 16000, and there is no income at all.
      const [flow] = await flowSums(tx, winStart, winEnd);
      const income = Number(flow.income_cents);
      const expense = Number(flow.expense_cents);
      assert(
        labels[0],
        income === 0 && expense === 6000,
        `income = ${income}, expense = ${expense} (expected 0 and 6000, not 16000)`,
      );

      // 125 (RF-34): expenses-by-category holds one row for the cash expense's split, 6000; the two
      // transfers carry no split and add nothing.
      const catRows = await categoryTotals(tx, winStart, winEnd);
      const catTotal = catRows.reduce((sum, row) => sum + Number(row.total_cents), 0);
      assert(
        labels[1],
        catRows.length === 1 && catRows[0].category_id === expenseCat && catTotal === 6000,
        `rows = ${catRows.length}, total = ${catTotal} (expected 1 row, 6000)`,
      );

      // 126 (RF-42, RF-66): the contribution nets the withdrawal against the return. The exact SQL of
      // `getMemberContributions`, replicated: 10000 credited on the way in, 3000 debited on the return.
      const contributions = await tx<{ user_id: string; contribution_cents: string }[]>`
        select member.user_id, coalesce(sum(member.delta), 0) as contribution_cents
        from (
          select
            case
              when ta.group_id is not null and fa.owner_user_id is not null then fa.owner_user_id
              when fa.group_id is not null and ta.owner_user_id is not null then ta.owner_user_id
            end as user_id,
            case
              when ta.group_id is not null and fa.owner_user_id is not null then t.amount_cents
              when fa.group_id is not null and ta.owner_user_id is not null then -t.amount_cents
              else 0
            end as delta
          from transactions t
          join accounts fa on fa.id = t.from_account_id
          join accounts ta on ta.id = t.to_account_id
          where t.kind = 'transfer'
            and t.occurred_at >= ${winStart} and t.occurred_at < ${winEnd}
        ) member
        where member.user_id is not null
        group by member.user_id`;
      assert(
        labels[2],
        contributions.length === 1 &&
          contributions[0].user_id === memberUser &&
          Number(contributions[0].contribution_cents) === 7000,
        `rows = ${contributions.length}, net = ${contributions[0]?.contribution_cents} (expected 7000 = 10000 − 3000, not 10000)`,
      );

      // 127 (RF-41): handing cash over is not a transaction — the scenario writes no fourth row for it.
      // Every movement touching the bank or the cash account is one of the three seeded above.
      const [{ count: movementCount }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions
        where from_account_id in (${bankAccount}, ${cashAccount})
           or to_account_id in (${bankAccount}, ${cashAccount})`;
      assert(
        labels[3],
        movementCount === "3" &&
          withdrawalTxn !== expenseTxn && expenseTxn !== returnTxn,
        `movements touching bank or cash = ${movementCount} (expected 3: withdrawal, cash expense, return — no hand-off row)`,
      );

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name = 'rls cash report'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls cash report' = ${probeCount}`,
  );
}

// Assertions 129-135: the per-scope import key (RF-51). Each of the four new entities carries a
// partial unique index on `(scope, external_ref)`, so a duplicate ref in one scope is refused while
// the same ref in a different scope stands; the derive trigger fills an omitted ref with `id::text`
// on all five entities (transactions included) while an explicit ref survives; and the column grant
// lets an authenticated member write the key under RLS. Every fixture is seeded through the app's own
// policies or as the owner where no policy hands the row out, and rolled back.
async function checkExternalRefKeys() {
  console.log("");
  const leaderUser = randomUUID();
  const groupId = randomUUID();
  const secondGroup = randomUUID();

  const labels = [
    "129. accounts: a duplicate external_ref in one scope is refused (23505); the same ref in two scopes both persist",
    "130. categories: a duplicate external_ref in one scope is refused (23505); the same ref in two scopes both persist",
    "131. recurring_rules: a duplicate external_ref in one scope is refused (23505); the same ref in two scopes both persist",
    "132. group_members: a duplicate external_ref in one group is refused (23505); the same ref in two groups both persist",
    "133. a null external_ref lands as id::text on all five entities — the derive trigger fired",
    "134. an explicit external_ref survives on all five entities — the WHEN guard held",
    "135. the column grant lets an authenticated member insert and update external_ref on an account under RLS",
  ];
  const tailLabel = "136. the rolled-back external_ref transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${leaderUser})`;
      await tx`insert into app_users (id) values (${leaderUser})`;

      // The group, its leader, a personal and a shared account, and one expense category per scope:
      // enough to book a rule and a movement, and to hold a ref in each of the two scopes.
      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls ext refs', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls ext refs leader', 'leader')`;
      const [{ id: leaderAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls ext refs leader cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: sharedAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${groupId}, true, 'rls ext refs shared cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: personalExpenseCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls ext refs personal expense', 'expense') returning id`;
      const [{ id: groupExpenseCat }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${groupId}, 'rls ext refs group expense', 'expense') returning id`;

      // 129: accounts. Seeded as the owner so the explicit scope columns reach the row untouched; only
      // the partial unique index can reject the duplicate, and only within the one owner scope.
      await tx`reset role`;
      await tx`insert into accounts (owner_user_id, name, kind, external_ref, initial_balance_on)
        values (${leaderUser}, 'rls ext refs acct owner', 'asset', 'ext-acct-dup', (now() at time zone 'America/Bogota')::date)`;
      let acctDup = "";
      await tx
        .savepoint(async (sp) => {
          await sp`insert into accounts (owner_user_id, name, kind, external_ref, initial_balance_on)
            values (${leaderUser}, 'rls ext refs acct owner dup', 'asset', 'ext-acct-dup', (now() at time zone 'America/Bogota')::date)`;
        })
        .catch((error: unknown) => {
          acctDup = pgErrorCode(error) ?? "none";
        });
      await tx`insert into accounts (group_id, is_shared, name, kind, external_ref, initial_balance_on)
        values (${groupId}, true, 'rls ext refs acct group', 'asset', 'ext-acct-dup', (now() at time zone 'America/Bogota')::date)`;
      const [{ count: acctScopes }] = await tx<{ count: string }[]>`
        select count(*)::text as count from accounts where external_ref = 'ext-acct-dup'`;
      assert(
        labels[0],
        acctDup === "23505" && acctScopes === "2",
        `dup sqlstate ${acctDup}, rows across scopes = ${acctScopes} (expected 23505 and 2)`,
      );

      // 130: categories, the same shape — owner scope and group scope hold the ref side by side.
      await tx`insert into categories (owner_user_id, name, kind, external_ref)
        values (${leaderUser}, 'rls ext refs cat owner', 'expense', 'ext-cat-dup')`;
      let catDup = "";
      await tx
        .savepoint(async (sp) => {
          await sp`insert into categories (owner_user_id, name, kind, external_ref)
            values (${leaderUser}, 'rls ext refs cat owner dup', 'expense', 'ext-cat-dup')`;
        })
        .catch((error: unknown) => {
          catDup = pgErrorCode(error) ?? "none";
        });
      await tx`insert into categories (group_id, name, kind, external_ref)
        values (${groupId}, 'rls ext refs cat group', 'expense', 'ext-cat-dup')`;
      const [{ count: catScopes }] = await tx<{ count: string }[]>`
        select count(*)::text as count from categories where external_ref = 'ext-cat-dup'`;
      assert(
        labels[1],
        catDup === "23505" && catScopes === "2",
        `dup sqlstate ${catDup}, rows across scopes = ${catScopes} (expected 23505 and 2)`,
      );

      // 131: recurring_rules. Booked as the writing member so the scope trigger derives owner vs group
      // from the account; the ref rides on the derived scope, and only its own scope's index refuses it.
      await enterUserContext(tx, leaderUser);
      await tx`insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on, external_ref)
        values (${leaderAccount}, 5000, ${personalExpenseCat}, 'monthly', 1, 15,
          (now() at time zone 'America/Bogota')::date + 30, 'ext-rule-dup')`;
      let ruleDup = "";
      await tx
        .savepoint(async (sp) => {
          await sp`insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on, external_ref)
            values (${leaderAccount}, 5000, ${personalExpenseCat}, 'monthly', 1, 15,
              (now() at time zone 'America/Bogota')::date + 30, 'ext-rule-dup')`;
        })
        .catch((error: unknown) => {
          ruleDup = pgErrorCode(error) ?? "none";
        });
      await tx`insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on, external_ref)
        values (${sharedAccount}, 6000, ${groupExpenseCat}, 'monthly', 1, 15,
          (now() at time zone 'America/Bogota')::date + 30, 'ext-rule-dup')`;
      await tx`reset role`;
      const [{ count: ruleScopes }] = await tx<{ count: string }[]>`
        select count(*)::text as count from recurring_rules where external_ref = 'ext-rule-dup'`;
      assert(
        labels[2],
        ruleDup === "23505" && ruleScopes === "2",
        `dup sqlstate ${ruleDup}, rows across scopes = ${ruleScopes} (expected 23505 and 2)`,
      );

      // 132: group_members carries a group scope alone — a duplicate ref in one group is refused, the
      // same ref in a second group stands. Seeded as the owner: no policy lets one member seed another group.
      await tx`insert into group_members (group_id, name, role, external_ref)
        values (${groupId}, 'rls ext refs gm one', 'member', 'ext-gm-dup')`;
      let gmDup = "";
      await tx
        .savepoint(async (sp) => {
          await sp`insert into group_members (group_id, name, role, external_ref)
            values (${groupId}, 'rls ext refs gm one dup', 'member', 'ext-gm-dup')`;
        })
        .catch((error: unknown) => {
          gmDup = pgErrorCode(error) ?? "none";
        });
      await tx`insert into groups (id, name, cash_mode) values (${secondGroup}, 'rls ext refs two', 'shared')`;
      await tx`insert into group_members (group_id, name, role, external_ref)
        values (${secondGroup}, 'rls ext refs gm two', 'member', 'ext-gm-dup')`;
      const [{ count: gmScopes }] = await tx<{ count: string }[]>`
        select count(*)::text as count from group_members where external_ref = 'ext-gm-dup'`;
      assert(
        labels[3],
        gmDup === "23505" && gmScopes === "2",
        `dup sqlstate ${gmDup}, rows across groups = ${gmScopes} (expected 23505 and 2)`,
      );

      // 133: an omitted ref is filled with the row's own id on every entity. Accounts, categories and
      // group_members as the owner; the rule and the movement as the writing member so their triggers run.
      await tx`reset role`;
      const [acctNull] = await tx<{ id: string; external_ref: string | null }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${leaderUser}, 'rls ext refs acct null', 'asset', (now() at time zone 'America/Bogota')::date)
        returning id, external_ref`;
      const [catNull] = await tx<{ id: string; external_ref: string | null }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${leaderUser}, 'rls ext refs cat null', 'expense') returning id, external_ref`;
      const [gmNull] = await tx<{ id: string; external_ref: string | null }[]>`
        insert into group_members (group_id, name, role)
        values (${groupId}, 'rls ext refs gm null', 'member') returning id, external_ref`;
      await enterUserContext(tx, leaderUser);
      const [ruleNull] = await tx<{ id: string; external_ref: string | null }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on)
        values (${leaderAccount}, 5000, ${personalExpenseCat}, 'monthly', 1, 15,
          (now() at time zone 'America/Bogota')::date + 30) returning id, external_ref`;
      const [txnNull] = await tx<{ id: string; external_ref: string | null }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${leaderAccount}, 5000, (now() at time zone 'America/Bogota')::date) returning id, external_ref`;
      assert(
        labels[4],
        acctNull.external_ref === acctNull.id &&
          catNull.external_ref === catNull.id &&
          gmNull.external_ref === gmNull.id &&
          ruleNull.external_ref === ruleNull.id &&
          txnNull.external_ref === txnNull.id,
        `acct ${acctNull.external_ref === acctNull.id}, cat ${catNull.external_ref === catNull.id}, gm ${gmNull.external_ref === gmNull.id}, rule ${ruleNull.external_ref === ruleNull.id}, txn ${txnNull.external_ref === txnNull.id}`,
      );

      // 134: an explicit ref is preserved unchanged on every entity — the WHEN guard skips the trigger.
      await tx`reset role`;
      const [acctKeep] = await tx<{ external_ref: string | null }[]>`
        insert into accounts (owner_user_id, name, kind, external_ref, initial_balance_on)
        values (${leaderUser}, 'rls ext refs acct keep', 'asset', 'ext-keep-acct', (now() at time zone 'America/Bogota')::date)
        returning external_ref`;
      const [catKeep] = await tx<{ external_ref: string | null }[]>`
        insert into categories (owner_user_id, name, kind, external_ref)
        values (${leaderUser}, 'rls ext refs cat keep', 'expense', 'ext-keep-cat') returning external_ref`;
      const [gmKeep] = await tx<{ external_ref: string | null }[]>`
        insert into group_members (group_id, name, role, external_ref)
        values (${groupId}, 'rls ext refs gm keep', 'member', 'ext-keep-gm') returning external_ref`;
      await enterUserContext(tx, leaderUser);
      const [ruleKeep] = await tx<{ external_ref: string | null }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on, external_ref)
        values (${leaderAccount}, 5000, ${personalExpenseCat}, 'monthly', 1, 15,
          (now() at time zone 'America/Bogota')::date + 30, 'ext-keep-rule') returning external_ref`;
      const [txnKeep] = await tx<{ external_ref: string | null }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, external_ref)
        values (${leaderAccount}, 5000, (now() at time zone 'America/Bogota')::date, 'ext-keep-txn') returning external_ref`;
      assert(
        labels[5],
        acctKeep.external_ref === "ext-keep-acct" &&
          catKeep.external_ref === "ext-keep-cat" &&
          gmKeep.external_ref === "ext-keep-gm" &&
          ruleKeep.external_ref === "ext-keep-rule" &&
          txnKeep.external_ref === "ext-keep-txn",
        `acct ${acctKeep.external_ref}, cat ${catKeep.external_ref}, gm ${gmKeep.external_ref}, rule ${ruleKeep.external_ref}, txn ${txnKeep.external_ref}`,
      );

      // 135: the column grant, exercised as an authenticated member in scope. The import stamps the key
      // on insert and can correct it on update — both land through the narrow INSERT/UPDATE(external_ref) grant.
      await enterUserContext(tx, leaderUser);
      const [grantIns] = await tx<{ id: string; external_ref: string | null }[]>`
        insert into accounts (owner_user_id, name, kind, external_ref, initial_balance_on)
        values (${leaderUser}, 'rls ext refs grant', 'asset', 'ext-grant-1', (now() at time zone 'America/Bogota')::date)
        returning id, external_ref`;
      const grantUpdate = await tx`update accounts set external_ref = 'ext-grant-2' where id = ${grantIns.id}`;
      const [{ external_ref: grantNow }] = await tx<{ external_ref: string | null }[]>`
        select external_ref from accounts where id = ${grantIns.id}`;
      assert(
        labels[6],
        grantIns.external_ref === "ext-grant-1" && grantUpdate.count === 1 && grantNow === "ext-grant-2",
        `inserted = ${grantIns.external_ref}, updated rows = ${grantUpdate.count}, now = ${grantNow}`,
      );

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls ext refs%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls ext refs%' = ${probeCount}`,
  );
}

// Assertions 137-142: the import commit (RF-51/52/45). It writes the whole file in one
// transaction: new rows insert, update rows overwrite by their stable key, a movement
// links to a file-new account's REAL id, and any mid-write failure rolls back every
// entity. Driven through `commitImport` itself — the shipped body, not a replica — under
// an injected user, so RLS and the triggers decide each row. Every fixture rolls back.
async function checkImportCommit() {
  console.log("");
  const owner = randomUUID();
  const failOwner = randomUUID();
  const today = "2026-01-01";
  const color = CATEGORY_COLORS[0];

  const labels = [
    "137. a single-file commit inserts new rows and overwrites an update row in place by its stable key",
    "138. re-committing the same file duplicates nothing and leaves the stable-keyed rows updated in place",
    "139. a movement whose split fails rolls back every entity the same transaction wrote",
    "140. a movement referencing a file-new account links to that account's real inserted id, not a placeholder",
    "141. the commit lands an audit row for its writes",
  ];
  const tailLabel = "142. the rolled-back import-commit transaction leaves no trace";

  // The placeholders a dev→prod file assigns its new referenced entities; the movement
  // points at these, and the commit must swap each for the real inserted id.
  const phAccountA = randomUUID();
  const phAccountC = randomUUID();
  const phCategory = randomUUID();

  const forcedRollback = Symbol("forced rollback");

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  const scope: CommitScope = { userId: owner, groupId: null };

  // The dev→prod file: two new accounts, one new category, and an expense that names a
  // file-new account and the file-new category — all by placeholder, never a real id.
  const firstFile: CommitInput = {
    members: [],
    categories: [
      {
        status: "new",
        index: 0,
        sheetRow: 2,
        externalRef: "imp-cat-1",
        placeholderId: phCategory,
        object: { name: "Imp Cat", kind: "expense", parentId: null, color },
      },
    ],
    accounts: [
      {
        status: "new",
        index: 0,
        sheetRow: 2,
        externalRef: "imp-acct-A",
        placeholderId: phAccountA,
        object: { name: "Imp A", kind: "asset", subtype: "cash", placement: "personal", institution: null, settlementCurrency: "COP", amount: "100", balanceOn: today },
      },
      {
        status: "new",
        index: 0,
        sheetRow: 2,
        externalRef: "imp-acct-C",
        placeholderId: phAccountC,
        object: { name: "Imp C", kind: "asset", subtype: "cash", placement: "personal", institution: null, settlementCurrency: "COP", amount: "200", balanceOn: today },
      },
    ],
    recurringRules: [],
    transactions: [
      {
        status: "new",
        index: 0,
        sheetRow: 2,
        externalRef: "imp-txn-1",
        placeholderId: null,
        object: {
          fromAccountId: phAccountC,
          toAccountId: null,
          amount: "50",
          occurredAt: today,
          description: null,
          externalRef: "imp-txn-1",
          splits: [{ categoryId: phCategory, amount: "50" }],
          labelIds: [],
        },
      },
    ],
  };

  await orm
    .transaction(async (tx) => {
      await tx.execute(dsql`insert into auth.users (id) values (${owner})`);
      await tx.execute(dsql`insert into app_users (id) values (${owner})`);
      await enter(tx, owner);

      await commitImport(tx, firstFile, scope);

      const [acctA] = await tx.execute<{ id: string; name: string }>(
        dsql`select id, name from accounts where external_ref = 'imp-acct-A'`,
      );
      const [acctC] = await tx.execute<{ id: string }>(
        dsql`select id from accounts where external_ref = 'imp-acct-C'`,
      );
      const [cat1] = await tx.execute<{ id: string }>(
        dsql`select id from categories where external_ref = 'imp-cat-1'`,
      );
      const [txn1] = await tx.execute<{ id: string; from_account_id: string | null }>(
        dsql`select id, from_account_id from transactions where external_ref = 'imp-txn-1'`,
      );
      const [split1] = await tx.execute<{ category_id: string }>(
        dsql`select category_id from transaction_splits where transaction_id = ${txn1.id}`,
      );

      // 140: the movement's account and its split's category are the REAL inserted ids,
      // never the placeholders the file carried.
      assert(
        labels[3],
        txn1.from_account_id === acctC.id &&
          split1.category_id === cat1.id &&
          txn1.from_account_id !== phAccountC &&
          split1.category_id !== phCategory,
        `from_account = ${txn1.from_account_id === acctC.id ? "real C" : txn1.from_account_id}, split cat = ${split1.category_id === cat1.id ? "real cat" : split1.category_id}`,
      );

      // A second file: one account updated by its key, one brand-new account.
      const secondFile: CommitInput = {
        members: [],
        categories: [],
        accounts: [
          {
            status: "update",
            index: 0,
            sheetRow: 2,
            externalRef: "imp-acct-A",
            placeholderId: null,
            object: { name: "Imp A2", kind: "asset", subtype: "bank", placement: "personal", institution: null, settlementCurrency: "COP", amount: "150", balanceOn: today },
          },
          {
            status: "new",
            index: 0,
            sheetRow: 2,
            externalRef: "imp-acct-B",
            placeholderId: randomUUID(),
            object: { name: "Imp B", kind: "asset", subtype: "cash", placement: "personal", institution: null, settlementCurrency: "COP", amount: "10", balanceOn: today },
          },
        ],
        recurringRules: [],
        transactions: [],
      };
      await commitImport(tx, secondFile, scope);

      const [acctARenamed] = await tx.execute<{ id: string; name: string }>(
        dsql`select id, name from accounts where external_ref = 'imp-acct-A'`,
      );
      const [{ count: acctBCount }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from accounts where external_ref = 'imp-acct-B'`,
      );
      // 137: the update overwrote the existing row (same id, new name), the new row landed.
      assert(
        labels[0],
        acctARenamed.id === acctA.id && acctARenamed.name === "Imp A2" && acctBCount === "1",
        `A id held = ${acctARenamed.id === acctA.id}, A name = ${acctARenamed.name}, B rows = ${acctBCount}`,
      );

      // 141: the writes left an audit trail — the new account C is captured on INSERT (RF-45).
      await tx.execute(dsql`reset role`);
      const [{ count: auditCount }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from audit_log
          where entity = 'accounts' and record_id = ${acctC.id} and action = 'INSERT'`,
      );
      assert(labels[4], Number(auditCount) >= 1, `audit rows for account C insert = ${auditCount}`);
      await enter(tx, owner);

      // Re-commit the FIRST file, now reclassified as updates the way the pipeline would on
      // a re-import: references resolve to the real ids, not placeholders.
      const [{ count: acctCountBefore }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from accounts where external_ref like 'imp-acct-%'`,
      );
      const [{ count: catCountBefore }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from categories where external_ref like 'imp-cat-%'`,
      );
      const [{ count: txnCountBefore }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from transactions where external_ref like 'imp-txn-%'`,
      );

      const reimport: CommitInput = {
        members: [],
        categories: [
          {
            status: "update",
            index: 0,
            sheetRow: 2,
            externalRef: "imp-cat-1",
            placeholderId: null,
            object: { name: "Imp Cat", kind: "expense", parentId: null, color },
          },
        ],
        accounts: [
          {
            status: "update",
            index: 0,
            sheetRow: 2,
            externalRef: "imp-acct-A",
            placeholderId: null,
            object: { name: "Imp A", kind: "asset", subtype: "cash", placement: "personal", institution: null, settlementCurrency: "COP", amount: "100", balanceOn: today },
          },
          {
            status: "update",
            index: 0,
            sheetRow: 2,
            externalRef: "imp-acct-C",
            placeholderId: null,
            object: { name: "Imp C", kind: "asset", subtype: "cash", placement: "personal", institution: null, settlementCurrency: "COP", amount: "200", balanceOn: today },
          },
        ],
        recurringRules: [],
        transactions: [
          {
            status: "update",
            index: 0,
            sheetRow: 2,
            externalRef: "imp-txn-1",
            placeholderId: null,
            object: {
              fromAccountId: acctC.id,
              toAccountId: null,
              amount: "50",
              occurredAt: today,
              description: null,
              externalRef: "imp-txn-1",
              splits: [{ categoryId: cat1.id, amount: "50" }],
              labelIds: [],
            },
          },
        ],
      };
      await commitImport(tx, reimport, scope);

      const [{ count: acctCountAfter }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from accounts where external_ref like 'imp-acct-%'`,
      );
      const [{ count: catCountAfter }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from categories where external_ref like 'imp-cat-%'`,
      );
      const [{ count: txnCountAfter }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from transactions where external_ref like 'imp-txn-%'`,
      );
      const [acctAReset] = await tx.execute<{ id: string; name: string }>(
        dsql`select id, name from accounts where external_ref = 'imp-acct-A'`,
      );
      // 138: no table gained a row, and the stable-keyed account is updated in place (same id, reset name).
      assert(
        labels[1],
        acctCountAfter === acctCountBefore &&
          catCountAfter === catCountBefore &&
          txnCountAfter === txnCountBefore &&
          acctAReset.id === acctA.id &&
          acctAReset.name === "Imp A",
        `accounts ${acctCountBefore}→${acctCountAfter}, categories ${catCountBefore}→${catCountAfter}, transactions ${txnCountBefore}→${txnCountAfter}, A in place = ${acctAReset.id === acctA.id}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  // 139: a file whose write fails mid-way. The expense names an INCOME category on its
  // split, which the match trigger refuses (23514) after the account and category already
  // landed — so the whole transaction must roll back, leaving zero rows on every entity.
  const failFile: CommitInput = {
    members: [],
    categories: [
      {
        status: "new",
        index: 0,
        sheetRow: 2,
        externalRef: "imp-fail-cat",
        placeholderId: randomUUID(),
        object: { name: "Imp Fail Cat", kind: "income", parentId: null, color },
      },
    ],
    accounts: [
      {
        status: "new",
        index: 0,
        sheetRow: 2,
        externalRef: "imp-fail-acct",
        placeholderId: randomUUID(),
        object: { name: "Imp Fail Acct", kind: "asset", subtype: "cash", placement: "personal", institution: null, settlementCurrency: "COP", amount: "100", balanceOn: today },
      },
    ],
    recurringRules: [],
    transactions: [],
  };
  // The movement points at the two file-new rows by their placeholders, an expense (from
  // set, to null) carrying the income category — the mismatch the trigger rejects.
  failFile.transactions = [
    {
      status: "new",
      index: 0,
      sheetRow: 2,
      externalRef: "imp-fail-txn",
      placeholderId: null,
      object: {
        fromAccountId: failFile.accounts[0].placeholderId,
        toAccountId: null,
        amount: "50",
        occurredAt: today,
        description: null,
        externalRef: "imp-fail-txn",
        splits: [{ categoryId: failFile.categories[0].placeholderId!, amount: "50" }],
        labelIds: [],
      },
    },
  ];

  let failCode = "";
  await orm
    .transaction(async (tx) => {
      await tx.execute(dsql`insert into auth.users (id) values (${failOwner})`);
      await tx.execute(dsql`insert into app_users (id) values (${failOwner})`);
      await enter(tx, failOwner);
      await commitImport(tx, failFile, { userId: failOwner, groupId: null });
    })
    .catch((error: unknown) => {
      failCode = pgErrorCode(error) ?? "none";
    });

  const [{ count: failAccts }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where external_ref = 'imp-fail-acct'`;
  const [{ count: failCats }] = await sql<{ count: string }[]>`
    select count(*)::text as count from categories where external_ref = 'imp-fail-cat'`;
  assert(
    labels[2],
    failCode === "23514" && failAccts === "0" && failCats === "0",
    `sqlstate ${failCode}, account rows = ${failAccts}, category rows = ${failCats} (expected 23514 and 0, 0)`,
  );

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where external_ref like 'imp-acct-%' or external_ref like 'imp-fail-%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, import rows surviving = ${probeCount}`,
  );
}

// Assertions 143-151: label governance. A group's labels bend to its leader and to no plain member,
// a personal label to its owner alone, read is universal inside the group, a label only tags a
// movement of its own scope, and the RF-89 filter narrows the ledger without widening it. Every
// fixture is seeded through the app's own policies inside a transaction that rolls back.
async function checkLabelPolicies() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const outsideUser = randomUUID();
  const groupId = randomUUID();
  const outsideGroupId = randomUUID();
  const color = CATEGORY_COLORS[0];

  const labels = [
    "143. a member reads the group's label",
    "144. a member cannot mint a label for the group",
    "145. a member's update of the group's label touches nothing",
    "146. a member's delete of the group's label touches nothing and the row survives",
    "147. the leader's insert, update and delete of a group label all stand",
    "148. a personal label yields to its owner and to no one else, the leader included",
    "149. a label only tags a movement of its own scope",
    "150. the RF-89 filter narrows the ledger to the labelled movement and never widens it",
  ];
  const tailLabel = "151. the rolled-back label transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      // Base identities, seeded as the owner before any role switch: `auth.users` is the FK target
      // for `app_users`, and both must exist before the app's own policies can seed anything else.
      await tx`insert into auth.users (id) values (${leaderUser}), (${memberUser}), (${outsideUser})`;
      await tx`insert into app_users (id) values (${leaderUser}), (${memberUser}), (${outsideUser})`;

      await enterUserContext(tx, leaderUser);
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls labels', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${leaderUser}, 'rls labels leader', 'leader')`;
      const [{ id: sharedAccount }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${groupId}, true, 'rls labels shared cash', 'asset',
          (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: groupLabel }] = await tx<{ id: string }[]>`
        insert into labels (group_id, name, color)
        values (${groupId}, 'rls labels group', ${color}) returning id`;

      // A second member with a login: no policy hands one member another's membership, so seed it as the owner.
      await tx`reset role`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${memberUser}, 'rls labels member', 'member')`;

      await enterUserContext(tx, memberUser);
      const [{ id: memberAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${memberUser}, 'rls labels member cash', 'asset',
          (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: personalLabel }] = await tx<{ id: string }[]>`
        insert into labels (owner_user_id, name, color)
        values (${memberUser}, 'rls labels personal', ${color}) returning id`;

      // Two group movements, both transfers so neither needs a split: the group wins the scope the
      // moment one side is the shared account. Only the first is ever labelled.
      const [{ id: labelledTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${memberAccount}, ${sharedAccount}, 4000,
          (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${sharedAccount}, ${memberAccount}, 1500, (now() at time zone 'America/Bogota')::date)`;

      // A second group neither of them belongs to, with a label and a movement of its own.
      await enterUserContext(tx, outsideUser);
      await tx`insert into groups (id, name, cash_mode)
        values (${outsideGroupId}, 'rls labels outside', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${outsideGroupId}, ${outsideUser}, 'rls labels outside leader', 'leader')`;
      const [{ id: outsideShared }] = await tx<{ id: string }[]>`
        insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
        values (${outsideGroupId}, true, 'rls labels outside cash', 'asset',
          (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: outsideOwn }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${outsideUser}, 'rls labels outside personal', 'asset',
          (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: outsideLabel }] = await tx<{ id: string }[]>`
        insert into labels (group_id, name, color)
        values (${outsideGroupId}, 'rls labels outside group', ${color}) returning id`;
      const [{ id: outsideTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${outsideOwn}, ${outsideShared}, 2500,
          (now() at time zone 'America/Bogota')::date) returning id`;
      await tx`insert into transaction_labels (transaction_id, label_id)
        values (${outsideTxn}, ${outsideLabel})`;

      // 143: universal read inside the group — a plain member sees the label the leader defined.
      await enterUserContext(tx, memberUser);
      const [{ count: memberSeesGroupLabel }] = await tx<{ count: string }[]>`
        select count(*)::text as count from labels where id = ${groupLabel}`;
      assert(labels[0], memberSeesGroupLabel === "1", `visible rows = ${memberSeesGroupLabel}`);

      // 144: `labels_insert_group` gates on the leader claim, so the member's group label never lands.
      await tx
        .savepoint(async (sp) => {
          await sp`insert into labels (group_id, name, color)
            values (${groupId}, 'rls labels forged', ${color})`;
          assert(labels[1], false, "a member minted a group label, which it must not");
        })
        .catch((error: unknown) => {
          assert(labels[1], pgErrorCode(error) === "42501", `sqlstate ${pgErrorCode(error) ?? "none"}`);
        });

      // 145-146: the same gate on update and delete — the row is filtered out, so both touch nothing.
      const memberUpdate = await tx`update labels set name = 'x' where id = ${groupLabel}`;
      assert(labels[2], memberUpdate.count === 0, `update rows = ${memberUpdate.count}`);
      const memberDelete = await tx`delete from labels where id = ${groupLabel}`;
      const [{ count: survives }] = await tx<{ count: string }[]>`
        select count(*)::text as count from labels where id = ${groupLabel}`;
      assert(
        labels[3],
        memberDelete.count === 0 && survives === "1",
        `delete rows = ${memberDelete.count}, surviving rows = ${survives}`,
      );

      // 147: the leader holds the whole of the group's set, on a label of its own so the fixture stands.
      await enterUserContext(tx, leaderUser);
      const [{ id: leaderLabel }] = await tx<{ id: string }[]>`
        insert into labels (group_id, name, color)
        values (${groupId}, 'rls labels leader made', ${color}) returning id`;
      const leaderUpdate = await tx`update labels set name = 'rls labels leader renamed'
        where id = ${leaderLabel}`;
      const leaderDelete = await tx`delete from labels where id = ${leaderLabel}`;
      assert(
        labels[4],
        leaderUpdate.count === 1 && leaderDelete.count === 1,
        `insert rows = 1, update rows = ${leaderUpdate.count}, delete rows = ${leaderDelete.count}`,
      );

      // 148: a personal label answers to its owner id, and the leader holds no exception over it.
      await enterUserContext(tx, memberUser);
      const [{ id: ownLabel }] = await tx<{ id: string }[]>`
        insert into labels (owner_user_id, name, color)
        values (${memberUser}, 'rls labels personal own', ${color}) returning id`;
      const ownerRename = await tx`update labels set name = 'rls labels personal renamed'
        where id = ${ownLabel}`;
      await enterUserContext(tx, leaderUser);
      const leaderOnPersonal = await tx`update labels set name = 'x' where id = ${ownLabel}`;
      await enterUserContext(tx, memberUser);
      const ownerDelete = await tx`delete from labels where id = ${ownLabel}`;
      assert(
        labels[5],
        ownerRename.count === 1 && leaderOnPersonal.count === 0 && ownerDelete.count === 1,
        `owner update rows = ${ownerRename.count}, leader update rows = ${leaderOnPersonal.count}, ` +
          `owner delete rows = ${ownerDelete.count}`,
      );

      // 149: the join policy admits the member's write on a group movement either way, so only
      // `assert_label_matches_transaction` can tell the two tags apart. The matching one stays, for 150.
      await enterUserContext(tx, memberUser);
      const matching = await tx`insert into transaction_labels (transaction_id, label_id)
        values (${labelledTxn}, ${groupLabel})`;
      await tx
        .savepoint(async (sp) => {
          await sp`insert into transaction_labels (transaction_id, label_id)
            values (${labelledTxn}, ${personalLabel})`;
          assert(labels[6], false, "a personal label tagged a group movement, which it must not");
        })
        .catch((error: unknown) => {
          const code = pgErrorCode(error);
          assert(
            labels[6],
            code === "23514" && matching.count === 1,
            `mismatched sqlstate ${code ?? "none"}, matching rows = ${matching.count}`,
          );
        });

      // 150: the predicate `listTransactions` composes for a label filter, replicated inline. The group's
      // own label narrows to the movement it tags; the other group's label yields nothing, and never
      // reaches past what the transactions policy already shows.
      const [{ count: visible }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions`;
      const byGroupLabel = await tx<{ id: string }[]>`
        select id from transactions where exists (
          select 1 from transaction_labels tl
          where tl.transaction_id = transactions.id and tl.label_id = ${groupLabel})`;
      const byOutsideLabel = await tx<{ id: string }[]>`
        select id from transactions where exists (
          select 1 from transaction_labels tl
          where tl.transaction_id = transactions.id and tl.label_id = ${outsideLabel})`;
      assert(
        labels[7],
        visible === "2" &&
          byGroupLabel.length === 1 &&
          byGroupLabel[0].id === labelledTxn &&
          byOutsideLabel.length === 0,
        `visible rows = ${visible}, group-label rows = ${byGroupLabel.length}, ` +
          `other-group-label rows = ${byOutsideLabel.length}`,
      );

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from labels where name like 'rls labels%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, labels surviving = ${probeCount}`,
  );
}

// Assertions 152-157: the credential write paths the screen drives. `owner_user_id` sits outside the
// INSERT grant, so no one mints a credential for someone else; the owner's eight-column read stands;
// the revoke lands under `authenticated` alone and takes the token out of the resolver's reach; and the
// token hash and the throttle counters stay outside the UPDATE grant. Every fixture is seeded through
// the app's own policies inside a transaction that rolls back.
async function checkWebhookCredentialOwnerWrites() {
  console.log("");
  const owner = randomUUID();
  const other = randomUUID();

  const labels = [
    "152. an insert naming another user as owner is refused",
    "153. the owner reads back the eight columns the list projects",
    "154. the owner's revoke lands and the second user's identical revoke touches nothing",
    "155. the resolver yields no row for a credential its owner revoked",
    "156. token_hash and both throttle counters are outside the update grant",
  ];
  const tailLabel = "157. the rolled-back credential write transaction leaves no trace";

  // 64 hex chars each: the token_hash length check demands exactly that.
  const ownerHash = createHash("sha256").update(randomUUID()).digest("hex");
  const forgedHash = createHash("sha256").update(randomUUID()).digest("hex");
  const rotatedHash = createHash("sha256").update(randomUUID()).digest("hex");

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${owner}), (${other})`;
      await tx`insert into app_users (id) values (${owner}), (${other})`;

      // Runs a barred statement in its own savepoint so the transaction survives the refusal, and
      // hands back whatever sqlstate Postgres raised — never one copied from the migration.
      const refusalOf = async (
        run: (sp: postgres.TransactionSql) => Promise<unknown>,
      ): Promise<string> => {
        let code: string | undefined;
        await tx
          .savepoint(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            code = pgErrorCode(error);
          });
        return code ?? "none";
      };

      await enterUserContext(tx, owner);
      const [credential] = await tx<{ id: string }[]>`
        insert into webhook_credentials (name, token_hash)
        values ('rls webhook writes live', ${ownerHash}) returning id`;

      // 152: the column privilege refuses the statement before the owner trigger can overwrite the
      // value, so the issue path has no way to mint a credential in someone else's name.
      const forgedCode = await refusalOf(
        (sp) => sp`insert into webhook_credentials (owner_user_id, name, token_hash)
          values (${other}, 'rls webhook writes forged', ${forgedHash})`,
      );
      assert(labels[0], forgedCode === "42501", `sqlstate ${forgedCode}`);

      // 153: the SELECT grant covers every column `listWebhookCredentials` projects. A column left out
      // of it would surface here as a privilege error, not as a null.
      type Projection = {
        id: string;
        name: string;
        default_account_id: string | null;
        default_category_id: string | null;
        rate_limit_per_min: number;
        last_used_at: Date | null;
        revoked_at: Date | null;
        created_at: Date;
      };
      let projected: Projection[] = [];
      let projectionCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          projected = await sp<Projection[]>`
            select id, name, default_account_id, default_category_id, rate_limit_per_min,
              last_used_at, revoked_at, created_at
            from webhook_credentials where id = ${credential.id}`;
        })
        .catch((error: unknown) => {
          projectionCode = pgErrorCode(error);
        });
      const projectedColumns = Object.keys(projected[0] ?? {});
      assert(
        labels[1],
        projectionCode === undefined &&
          projected.length === 1 &&
          projected[0].id === credential.id &&
          projectedColumns.length === 8,
        `rows = ${projected.length}, columns = ${projectedColumns.length}, sqlstate ${projectionCode ?? "none"}`,
      );

      // 154: both statements are identical and both run as `authenticated`; only the update policy's
      // owner filter tells them apart, so the second user's revoke finds no row to touch.
      const ownerRevoke = await tx`update webhook_credentials set revoked_at = now()
        where id = ${credential.id}`;
      const [{ stamped }] = await tx<{ stamped: boolean }[]>`
        select revoked_at is not null as stamped from webhook_credentials where id = ${credential.id}`;
      await enterUserContext(tx, other);
      const otherRevoke = await tx`update webhook_credentials set revoked_at = now()
        where id = ${credential.id}`;
      assert(
        labels[2],
        ownerRevoke.count === 1 && stamped === true && otherRevoke.count === 0,
        `owner update rows = ${ownerRevoke.count}, revoked_at set = ${stamped}, ` +
          `second user update rows = ${otherRevoke.count}`,
      );

      // 155: assertion 90 revokes as the object owner; this one revoked through the screen's own path,
      // and the resolver on the base connection stops answering for the hash either way.
      await tx`reset role`;
      const resolved = await tx<{ owner_user_id: string }[]>`
        select owner_user_id from private.resolve_webhook_credential(${ownerHash})`;
      assert(labels[3], resolved.length === 0, `resolver rows = ${resolved.length}`);

      // 156: the UPDATE grant lists name, the defaults, the rate limit and revoked_at and nothing else.
      // A token is replaced by issuing a new credential, and the window answers to the resolver alone.
      await enterUserContext(tx, owner);
      const tokenCode = await refusalOf(
        (sp) => sp`update webhook_credentials set token_hash = ${rotatedHash}
          where id = ${credential.id}`,
      );
      const countCode = await refusalOf(
        (sp) => sp`update webhook_credentials set rate_count = 0 where id = ${credential.id}`,
      );
      const windowCode = await refusalOf(
        (sp) => sp`update webhook_credentials set rate_window_started_at = now()
          where id = ${credential.id}`,
      );
      assert(
        labels[4],
        tokenCode === "42501" && countCode === "42501" && windowCode === "42501",
        `token_hash sqlstate ${tokenCode}, rate_count sqlstate ${countCode}, ` +
          `rate_window_started_at sqlstate ${windowCode}`,
      );

      // Forces `sql.begin` to issue ROLLBACK: nothing this function wrote may survive it.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from webhook_credentials where name like 'rls webhook writes%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls webhook writes%' = ${probeCount}`,
  );
}

// Assertions 158-164: delivery and shape ownership, derived state, immutable insert state,
// per-owner idempotency and the checks tying pending rows to unresolved proposals.
async function checkIngestDeliveryPolicies() {
  console.log("");
  const owner = randomUUID();
  const other = randomUUID();
  const ownerShape = createHash("sha256").update(randomUUID()).digest("hex");
  const rejectedShape = createHash("sha256").update(randomUUID()).digest("hex");
  const approvedShape = createHash("sha256").update(randomUUID()).digest("hex");
  const auditShape = createHash("sha256").update(randomUUID()).digest("hex");
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "158. delivery and shape owner triggers stamp auth.uid and every ingest table writes an audit row",
    "159. a second user reads and updates none of the first user's deliveries",
    "160. insert grants bar forged state while a plain delivery lands pending and unresolved",
    "161. rejected shapes silence new deliveries while approved shapes leave them pending",
    "162. delivery references are unique per owner, not globally",
    "163. pending deliveries cannot name a transaction or a resolution time",
    "164. shape decisions are owner-isolated and unique per owner and shape",
  ];

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${owner}), (${other})`;
      await tx`insert into app_users (id) values (${owner}), (${other})`;

      const refusalOf = async (
        run: (sp: postgres.TransactionSql) => Promise<unknown>,
      ): Promise<string> => {
        let code: string | undefined;
        await tx
          .savepoint(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            code = pgErrorCode(error);
          });
        return code ?? "none";
      };

      await enterUserContext(tx, owner);
      const [{ id: categoryId }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${owner}, 'rls ingest audit category', 'expense') returning id`;
      const [{ id: accountId }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${owner}, 'rls ingest account', 'asset',
          (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: transactionId }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${accountId}, 100, (now() at time zone 'America/Bogota')::date) returning id`;

      const forgedOwnerCode = await refusalOf(
        (sp) => sp`insert into ingest_deliveries
          (owner_user_id, external_ref, raw_text, shape_hash)
          values (${other}, 'rls-ingest-forged-owner', 'fixture', ${ownerShape})`,
      );
      const [delivery] = await tx<
        { id: string; owner_user_id: string; status: string; resolved_at: Date | null }[]
      >`insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-ingest-owner', 'fixture', ${ownerShape})
        returning id, owner_user_id, status, resolved_at`;
      const [shape] = await tx<{ id: string; owner_user_id: string }[]>`
        insert into ingest_shapes (shape_hash, decision, sample_text)
        values (${auditShape}, 'approved', 'fixture') returning id, owner_user_id`;
      await tx`select private.remember_ingest_merchant(
        'rls-ingest-audit-merchant', 'RLS ingest audit merchant', ${categoryId})`;
      const [merchant] = await tx<{ id: string; owner_user_id: string }[]>`
        select id, owner_user_id from ingest_merchants
        where merchant_key = 'rls-ingest-audit-merchant'`;
      await tx`reset role`;
      const auditRows = await tx<{ entity: string; record_id: string }[]>`
        select entity, record_id from audit_log
        where action = 'INSERT' and (
          (entity = 'ingest_deliveries' and record_id = ${delivery.id}) or
          (entity = 'ingest_shapes' and record_id = ${shape.id}) or
          (entity = 'ingest_merchants' and record_id = ${merchant.id})
        )`;
      const audited = new Set(
        auditRows.map((row) => `${row.entity}:${row.record_id}`),
      );
      assert(
        labels[0],
        forgedOwnerCode === "42501" &&
          delivery.owner_user_id === owner &&
          shape.owner_user_id === owner &&
          merchant.owner_user_id === owner &&
          audited.has(`ingest_deliveries:${delivery.id}`) &&
          audited.has(`ingest_shapes:${shape.id}`) &&
          audited.has(`ingest_merchants:${merchant.id}`),
        `owner sqlstate ${forgedOwnerCode}, stamped owners = ${delivery.owner_user_id === owner}/${shape.owner_user_id === owner}/${merchant.owner_user_id === owner}, audit rows = ${auditRows.length}`,
      );

      await enterUserContext(tx, other);
      const [{ count: otherVisible }] = await tx<{ count: string }[]>`
        select count(*)::text as count from ingest_deliveries where id = ${delivery.id}`;
      const otherUpdate = await tx`update ingest_deliveries
        set status = 'rejected', resolved_at = now() where id = ${delivery.id}`;
      assert(
        labels[1],
        otherVisible === "0" && otherUpdate.count === 0,
        `visible rows = ${otherVisible}, updated rows = ${otherUpdate.count}`,
      );

      await enterUserContext(tx, owner);
      const statusCode = await refusalOf(
        (sp) => sp`insert into ingest_deliveries
          (external_ref, raw_text, shape_hash, status)
          values ('rls-ingest-forged-status', 'fixture', ${ownerShape}, 'accepted')`,
      );
      const resolvedCode = await refusalOf(
        (sp) => sp`insert into ingest_deliveries
          (external_ref, raw_text, shape_hash, resolved_at)
          values ('rls-ingest-forged-resolved', 'fixture', ${ownerShape}, now())`,
      );
      const transactionCode = await refusalOf(
        (sp) => sp`insert into ingest_deliveries
          (external_ref, raw_text, shape_hash, transaction_id)
          values ('rls-ingest-forged-transaction', 'fixture', ${ownerShape}, ${transactionId})`,
      );
      const [plain] = await tx<{ status: string; resolved_at: Date | null }[]>`
        insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-ingest-plain', 'fixture', ${ownerShape})
        returning status, resolved_at`;
      assert(
        labels[2],
        statusCode === "42501" &&
          resolvedCode === "42501" &&
          transactionCode === "42501" &&
          plain.status === "pending" &&
          plain.resolved_at === null,
        `status sqlstate ${statusCode}, resolved_at sqlstate ${resolvedCode}, transaction_id sqlstate ${transactionCode}, stored ${plain.status}/${plain.resolved_at === null ? "null" : "set"}`,
      );

      await tx`insert into ingest_shapes (shape_hash, decision, sample_text)
        values (${rejectedShape}, 'rejected', 'fixture'),
               (${approvedShape}, 'approved', 'fixture')`;
      const [silenced] = await tx<{ status: string; resolved_at: Date | null }[]>`
        insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-ingest-silenced', 'fixture', ${rejectedShape})
        returning status, resolved_at`;
      const [approved] = await tx<{ status: string; resolved_at: Date | null }[]>`
        insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-ingest-approved', 'fixture', ${approvedShape})
        returning status, resolved_at`;
      assert(
        labels[3],
        silenced.status === "rejected" &&
          silenced.resolved_at !== null &&
          approved.status === "pending" &&
          approved.resolved_at === null,
        `rejected shape stored ${silenced.status}/${silenced.resolved_at ? "set" : "null"}, approved shape stored ${approved.status}/${approved.resolved_at ? "set" : "null"}`,
      );

      const duplicateCode = await refusalOf(
        (sp) => sp`insert into ingest_deliveries (external_ref, raw_text, shape_hash)
          values ('rls-ingest-owner', 'fixture duplicate', ${ownerShape})`,
      );
      await enterUserContext(tx, other);
      const sameRefOther = await tx<{ id: string }[]>`
        insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-ingest-owner', 'fixture other owner', ${ownerShape}) returning id`;
      assert(
        labels[4],
        duplicateCode === "23505" && sameRefOther.length === 1,
        `owner duplicate sqlstate ${duplicateCode}, second-owner rows = ${sameRefOther.length}`,
      );

      await enterUserContext(tx, owner);
      const transactionPendingCode = await refusalOf(
        (sp) => sp`update ingest_deliveries set transaction_id = ${transactionId}
          where id = ${delivery.id}`,
      );
      const resolvedPendingCode = await refusalOf(
        (sp) => sp`update ingest_deliveries set resolved_at = now()
          where id = ${delivery.id}`,
      );
      assert(
        labels[5],
        transactionPendingCode === "23514" && resolvedPendingCode === "23514",
        `transaction_id sqlstate ${transactionPendingCode}, resolved_at sqlstate ${resolvedPendingCode}`,
      );

      await enterUserContext(tx, other);
      const [{ count: otherShapes }] = await tx<{ count: string }[]>`
        select count(*)::text as count from ingest_shapes where id = ${shape.id}`;
      const otherShapeUpdate = await tx`update ingest_shapes set decision = 'rejected'
        where id = ${shape.id}`;
      await enterUserContext(tx, owner);
      const shapeDuplicateCode = await refusalOf(
        (sp) => sp`insert into ingest_shapes (shape_hash, decision, sample_text)
          values (${auditShape}, 'rejected', 'fixture duplicate')`,
      );
      assert(
        labels[6],
        otherShapes === "0" &&
          otherShapeUpdate.count === 0 &&
          shapeDuplicateCode === "23505",
        `second-user rows = ${otherShapes}, updates = ${otherShapeUpdate.count}, duplicate sqlstate ${shapeDuplicateCode}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
}

type MerchantSnapshot = {
  id: string;
  owner_user_id: string;
  merchant_key: string;
  merchant_label: string;
  state: "learning" | "trusted" | "ambiguous";
  candidate_category_id: string | null;
  streak: number;
  trusted_category_id: string | null;
  created_at: Date;
  updated_at: Date;
};

// Assertions 165-172: only the definer writes merchant memory, its transition is sticky and
// owner-scoped, the shape definer can read forced-RLS rows, and the resolver returns its id.
async function checkIngestMerchantTrust() {
  console.log("");
  const owner = randomUUID();
  const other = randomUUID();
  const rejectedShape = createHash("sha256").update(randomUUID()).digest("hex");
  const tokenHash = createHash("sha256").update(randomUUID()).digest("hex");
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "165. authenticated cannot insert or update merchant memory directly",
    "166. two matching approvals trust a merchant and a contradiction makes it ambiguous",
    "167. ambiguity stays pinned after later matching approvals",
    "168. a disagreement while learning restarts the streak without pinning ambiguity",
    "169. merchant memory is isolated per user even for the same merchant key",
    "170. the delivery-state definer owner bypasses forced RLS to read silenced shapes",
    "171. the credential resolver permanently proves the credential id projection",
  ];
  const tailLabel = "172. the rolled-back ingest transaction leaves no trace";

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${owner}), (${other})`;
      await tx`insert into app_users (id) values (${owner}), (${other})`;

      const refusalOf = async (
        run: (sp: postgres.TransactionSql) => Promise<unknown>,
      ): Promise<string> => {
        let code: string | undefined;
        await tx
          .savepoint(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            code = pgErrorCode(error);
          });
        return code ?? "none";
      };
      const readMerchant = async (key: string): Promise<MerchantSnapshot> => {
        const [row] = await tx<MerchantSnapshot[]>`
          select * from ingest_merchants where merchant_key = ${key}`;
        if (!row) throw new Error(`missing merchant fixture ${key}`);
        return row;
      };

      await enterUserContext(tx, owner);
      const [{ id: categoryA }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${owner}, 'rls ingest merchant A', 'expense') returning id`;
      const [{ id: categoryB }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${owner}, 'rls ingest merchant B', 'expense') returning id`;
      await tx`select private.remember_ingest_merchant(
        'rls-ingest-main', 'RLS ingest main', ${categoryA})`;

      const directInsertCode = await refusalOf(
        (sp) => sp`insert into ingest_merchants
          (owner_user_id, merchant_key, merchant_label)
          values (${owner}, 'rls-ingest-forged', 'RLS ingest forged')`,
      );
      const directUpdateCode = await refusalOf(
        (sp) => sp`update ingest_merchants set state = 'trusted'
          where merchant_key = 'rls-ingest-main'`,
      );
      assert(
        labels[0],
        directInsertCode === "42501" && directUpdateCode === "42501",
        `insert sqlstate ${directInsertCode}, update sqlstate ${directUpdateCode}`,
      );

      const first = await readMerchant("rls-ingest-main");
      await tx`select private.remember_ingest_merchant(
        'rls-ingest-main', 'RLS ingest main', ${categoryA})`;
      const second = await readMerchant("rls-ingest-main");
      await tx`select private.remember_ingest_merchant(
        'rls-ingest-main', 'RLS ingest main', ${categoryB})`;
      const third = await readMerchant("rls-ingest-main");
      assert(
        labels[1],
        first.state === "learning" &&
          first.streak === 1 &&
          first.trusted_category_id === null &&
          second.state === "trusted" &&
          second.streak === 2 &&
          second.trusted_category_id === categoryA &&
          third.state === "ambiguous" &&
          third.trusted_category_id === null,
        `first ${first.state}/${first.streak}/${first.trusted_category_id}, second ${second.state}/${second.streak}/${second.trusted_category_id}, third ${third.state}/${third.streak}/${third.trusted_category_id}`,
      );

      await tx`select private.remember_ingest_merchant(
        'rls-ingest-main', 'RLS ingest main', ${categoryA})`;
      await tx`select private.remember_ingest_merchant(
        'rls-ingest-main', 'RLS ingest main', ${categoryA})`;
      const sticky = await readMerchant("rls-ingest-main");
      assert(
        labels[2],
        sticky.state === "ambiguous" && sticky.trusted_category_id === null,
        `state = ${sticky.state}, streak = ${sticky.streak}, trusted_category_id = ${sticky.trusted_category_id}`,
      );

      await tx`select private.remember_ingest_merchant(
        'rls-ingest-learning', 'RLS ingest learning', ${categoryA})`;
      await tx`select private.remember_ingest_merchant(
        'rls-ingest-learning', 'RLS ingest learning', ${categoryB})`;
      const learning = await readMerchant("rls-ingest-learning");
      assert(
        labels[3],
        learning.state === "learning" &&
          learning.streak === 1 &&
          learning.candidate_category_id === categoryB &&
          learning.trusted_category_id === null,
        `state = ${learning.state}, streak = ${learning.streak}, candidate_category_id = ${learning.candidate_category_id}, trusted_category_id = ${learning.trusted_category_id}`,
      );

      const ownerBefore = await readMerchant("rls-ingest-main");
      await enterUserContext(tx, other);
      const [{ id: otherCategory }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${other}, 'rls ingest merchant other', 'expense') returning id`;
      await tx`select private.remember_ingest_merchant(
        'rls-ingest-main', 'RLS ingest main', ${otherCategory})`;
      const otherRows = await tx<MerchantSnapshot[]>`
        select * from ingest_merchants where merchant_key = 'rls-ingest-main'`;
      await enterUserContext(tx, owner);
      const ownerAfter = await readMerchant("rls-ingest-main");
      assert(
        labels[4],
        otherRows.length === 1 &&
          otherRows[0].owner_user_id === other &&
          JSON.stringify(ownerAfter) === JSON.stringify(ownerBefore),
        `second-user visible rows = ${otherRows.length}, owns row = ${otherRows[0]?.owner_user_id === other}, first row unchanged = ${JSON.stringify(ownerAfter) === JSON.stringify(ownerBefore)}`,
      );

      await tx`insert into ingest_shapes (shape_hash, decision, sample_text)
        values (${rejectedShape}, 'rejected', 'fixture')`;
      const [silenced] = await tx<{ status: string; resolved_at: Date | null }[]>`
        insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-ingest-definer', 'fixture', ${rejectedShape})
        returning status, resolved_at`;
      await tx`reset role`;
      const [definer] = await tx<
        { security_definer: boolean; owner: string; bypass: boolean; forced: boolean }[]
      >`select p.prosecdef as security_definer, r.rolname as owner,
          r.rolbypassrls as bypass, c.relforcerowsecurity as forced
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        join pg_class c on c.oid = 'finances.ingest_shapes'::regclass
        where n.nspname = 'private' and p.proname = 'set_ingest_delivery_state'`;
      assert(
        labels[5],
        definer.security_definer &&
          definer.owner === "postgres" &&
          definer.bypass &&
          definer.forced &&
          silenced.status === "rejected" &&
          silenced.resolved_at !== null,
        `security definer = ${definer.security_definer}, owner = ${definer.owner}, bypass = ${definer.bypass}, forced = ${definer.forced}, stored = ${silenced.status}/${silenced.resolved_at ? "set" : "null"}`,
      );

      await enterUserContext(tx, owner);
      const [credential] = await tx<{ id: string }[]>`
        insert into webhook_credentials (name, token_hash)
        values ('rls ingest resolver id', ${tokenHash}) returning id`;
      await tx`reset role`;
      const resolved = await tx<{ id: string; owner_user_id: string }[]>`
        select id, owner_user_id from private.resolve_webhook_credential(${tokenHash})`;
      assert(
        labels[6],
        resolved.length === 1 &&
          resolved[0].id === credential.id &&
          resolved[0].owner_user_id === owner,
        `rows = ${resolved.length}, credential id matches = ${resolved[0]?.id === credential.id}, owner matches = ${resolved[0]?.owner_user_id === owner}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`
    select current_user`;
  const [survivors] = await sql<
    { deliveries: string; shapes: string; merchants: string }[]
  >`select
      (select count(*)::text from ingest_deliveries
        where external_ref like 'rls-ingest-%') as deliveries,
      (select count(*)::text from ingest_shapes
        where sample_text = 'fixture' and shape_hash = ${rejectedShape}) as shapes,
      (select count(*)::text from ingest_merchants
        where merchant_key like 'rls-ingest-%') as merchants`;
  assert(
    tailLabel,
    afterUser === "postgres" &&
      survivors.deliveries === "0" &&
      survivors.shapes === "0" &&
      survivors.merchants === "0",
    `current_user = ${afterUser}, deliveries = ${survivors.deliveries}, shapes = ${survivors.shapes}, merchants = ${survivors.merchants}`,
  );
}

// A DrizzleQueryError names only the query it ran: the driver's message hangs off
// the cause chain, like its sqlstate. Both are reported, because `permission denied
// for table X` and `new row violates row-level security policy` are both 42501.
function describeRefusal(error: unknown): string {
  let current: unknown = error;
  let message = String(error);

  for (let hop = 0; hop < 5; hop++) {
    if (typeof current !== "object" || current === null) break;
    if ("message" in current && typeof current.message === "string") {
      message = current.message;
    }
    current = "cause" in current ? current.cause : undefined;
  }

  return `sqlstate ${pgErrorCode(error) ?? "none"} — ${message.split("\n")[0]}`;
}

// The mapping `insertRow` writes through: a JS key becomes a column name here, and
// nowhere else. `getTableConfig(...).columns[].name` returns the key itself, so a
// proof built on it would agree with the helper while both were wrong.
const insertCasing = new CasingCache("snake_case");

// Every table `db/schema` exports, with the column names the helper would write.
function schemaTables(): { name: string; columns: string[] }[] {
  // Cast first: the exports are a union of concrete table types, and a predicate
  // narrowing to the base class is not assignable to any one of them.
  return (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => ({
      name: getTableConfig(table).name,
      columns: Object.values(getTableColumns(table) as Record<string, PgColumn>).map(
        (column) => insertCasing.getColumnCasing(column),
      ),
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

// The columns `authenticated` holds NO INSERT on, per table, read off the live
// database and pinned here. A migration that widens or narrows a grant fails 174
// and has to change this map on purpose. An empty array is a table whose every
// column may be written; a table absent from the app's schema is a failure too.
const INSERT_GRANT_GAPS: Record<string, string[]> = {
  // `created_by` is stamped by the trigger; the counted figure, the day and the account are the input.
  account_reconciliations: ["created_at", "created_by", "id"],
  account_statements: ["closed_at", "id"],
  accounts: ["archived_at", "created_at", "id", "updated_at"],
  // The allowed list and the sign-in counter carry no grant at all (RF-145, RF-143).
  allowed_emails: ["added_at", "email"],
  app_users: ["created_at", "updated_at"],
  audit_log: [
    "action",
    "actor_user_id",
    "after_data",
    "before_data",
    "entity",
    "group_id",
    "id",
    "occurred_at",
    "owner_user_id",
    "record_id",
  ],
  budgets: ["archived_at", "created_at", "id", "updated_at"],
  categories: ["created_at", "id", "updated_at"],
  debt_terms: ["created_at", "updated_at"],
  goal_contributions: ["id"],
  group_members: ["archived_at", "created_at", "id", "invite_state", "updated_at"],
  groups: ["created_at", "updated_at"],
  // Every column, both here and in the UPDATE map: `private.remember_counterparty` is the
  // sole writer, so a client cannot forge a state transition. Forgetting one is the DELETE.
  ingest_counterparties: [
    "candidate_account_id",
    "created_at",
    "id",
    "owner_user_id",
    "pattern_key",
    "pattern_label",
    "side",
    "state",
    "streak",
    "trusted_account_id",
    "updated_at",
  ],
  ingest_deliveries: [
    "created_at",
    "id",
    "owner_user_id",
    "resolved_at",
    "silenced_on_arrival",
    "status",
    "transaction_id",
    "updated_at",
  ],
  ingest_merchants: [
    "candidate_category_id",
    "created_at",
    "id",
    "merchant_key",
    "merchant_label",
    "owner_user_id",
    "state",
    "streak",
    "trusted_category_id",
    "updated_at",
  ],
  ingest_shapes: ["created_at", "id", "owner_user_id", "updated_at"],
  installment_lines: ["created_at", "id", "paid_transaction_id"],
  installment_plans: ["created_at", "id", "updated_at"],
  labels: ["created_at", "id", "updated_at"],
  planned_payments: [
    "created_at",
    "created_by",
    "group_id",
    "id",
    "owner_user_id",
    "settled_transaction_id",
    "status",
    "updated_at",
  ],
  recurring_rules: [
    "created_at",
    "created_by",
    "group_id",
    "id",
    "is_active",
    "owner_user_id",
    "paused_reason",
    "updated_at",
  ],
  savings_goals: ["archived_at", "created_at", "id", "updated_at"],
  sign_in_claims: ["client_key", "count", "day"],
  transaction_labels: [],
  // `marked_by` is stamped by the trigger from auth.uid(); the movement and the rule are the input.
  transaction_reviews: ["id", "marked_at", "marked_by"],
  transaction_sources: ["created_at", "id"],
  transaction_splits: ["id"],
  transactions: [
    "created_at",
    "created_by",
    "group_id",
    "id",
    "kind",
    "owner_user_id",
    "reconciliation_id",
    "recurring_rule_id",
    "reviewed_at",
    "updated_at",
  ],
  webhook_credentials: [
    "created_at",
    "id",
    "last_used_at",
    "owner_user_id",
    "rate_count",
    "rate_window_started_at",
    "revoked_at",
    "updated_at",
  ],
};

// The columns `authenticated` holds NO UPDATE on, in the same shape as the INSERT map.
// `ingest_deliveries.silenced_on_arrival` is deliberately absent: it carries an UPDATE
// grant, so it is no gap here — the trigger alone writes it on the way in, which is why
// the INSERT map above lists it.
const UPDATE_GRANT_GAPS: Record<string, string[]> = {
  // A reconciliation is final: no column is writable.
  account_reconciliations: [
    "account_id",
    "counted_balance_cents",
    "created_at",
    "created_by",
    "external_ref",
    "id",
    "reconciled_on",
  ],
  account_statements: [
    "account_id",
    "closed_at",
    "closing_balance_cents",
    "credits_cents",
    "cut_off_date",
    "debits_cents",
    "fees_charged_cents",
    "id",
    "interest_charged_cents",
    "minimum_payment_cents",
    "opening_balance_cents",
    "payment_due_date",
    "period_start",
    "source",
  ],
  accounts: ["created_at", "group_id", "id", "kind", "owner_user_id", "updated_at"],
  allowed_emails: ["added_at", "email"],
  app_users: ["created_at", "id", "updated_at"],
  audit_log: [
    "action",
    "actor_user_id",
    "after_data",
    "before_data",
    "entity",
    "group_id",
    "id",
    "occurred_at",
    "owner_user_id",
    "record_id",
  ],
  budgets: ["category_id", "created_at", "external_ref", "group_id", "id", "owner_user_id", "updated_at"],
  categories: ["created_at", "group_id", "id", "kind", "owner_user_id", "updated_at"],
  debt_terms: ["account_id", "created_at", "updated_at"],
  goal_contributions: ["amount_cents", "created_at", "external_ref", "goal_id", "id", "transaction_id"],
  group_members: [
    "created_at",
    "external_ref",
    "group_id",
    "id",
    "invite_state",
    "role",
    "updated_at",
    "user_id",
  ],
  groups: ["created_at", "id", "updated_at"],
  ingest_counterparties: [
    "candidate_account_id",
    "created_at",
    "id",
    "owner_user_id",
    "pattern_key",
    "pattern_label",
    "side",
    "state",
    "streak",
    "trusted_account_id",
    "updated_at",
  ],
  ingest_deliveries: [
    "category_source",
    "created_at",
    "credential_id",
    "external_ref",
    "id",
    "merchant_key",
    "merchant_label",
    "owner_user_id",
    "proposed_account_id",
    "proposed_amount_cents",
    "proposed_category_id",
    "proposed_description",
    "proposed_direction",
    "proposed_occurred_at",
    "raw_text",
    "shape_hash",
    "updated_at",
  ],
  ingest_merchants: [
    "candidate_category_id",
    "created_at",
    "id",
    "merchant_key",
    "merchant_label",
    "owner_user_id",
    "state",
    "streak",
    "trusted_category_id",
    "updated_at",
  ],
  ingest_shapes: ["created_at", "id", "owner_user_id", "sample_text", "shape_hash", "updated_at"],
  installment_lines: ["amount_cents", "created_at", "due_date", "id", "plan_id", "seq"],
  installment_plans: [
    "account_id",
    "aval_cents",
    "created_at",
    "down_payment_cents",
    "frequency",
    "id",
    "interest_rate",
    "n_installments",
    "principal_cents",
    "start_date",
    "updated_at",
  ],
  labels: ["created_at", "external_ref", "group_id", "id", "owner_user_id", "updated_at"],
  planned_payments: ["created_at", "created_by", "group_id", "id", "owner_user_id", "updated_at"],
  recurring_rules: ["created_at", "created_by", "group_id", "id", "owner_user_id", "paused_reason", "updated_at"],
  savings_goals: ["created_at", "external_ref", "group_id", "id", "owner_user_id", "updated_at"],
  sign_in_claims: ["client_key", "count", "day"],
  transaction_labels: ["label_id", "transaction_id"],
  // A mark is final: no column is writable.
  transaction_reviews: ["id", "marked_at", "marked_by", "rule", "transaction_id"],
  transaction_sources: [
    "account_id",
    "created_at",
    "id",
    "source_ref",
    "source_seq",
    "statement_id",
    "transaction_id",
  ],
  transaction_splits: ["id", "transaction_id"],
  transactions: [
    // Quick entry decides it once, on the way in.
    "amount_from_words",
    "created_at",
    "created_by",
    "external_ref",
    "group_id",
    "id",
    "kind",
    "owner_user_id",
    "reconciliation_id",
    "recurring_rule_id",
    "updated_at",
  ],
  webhook_credentials: [
    "created_at",
    "id",
    "last_used_at",
    "owner_user_id",
    "rate_count",
    "rate_window_started_at",
    "token_hash",
    "updated_at",
  ],
};

// DELETE and TRUNCATE have no column form, so these are table lists. A row leaves through a
// DELETE the policies filter; TRUNCATE consults neither a policy nor a row trigger, so the
// audit trail (RF-45) has nothing to record — the list stays empty.
const DELETE_GRANTS: string[] = [
  "accounts",
  "budgets",
  "categories",
  "debt_terms",
  "goal_contributions",
  "group_members",
  "ingest_counterparties",
  "ingest_merchants",
  "ingest_shapes",
  "installment_lines",
  "installment_plans",
  "labels",
  "planned_payments",
  "recurring_rules",
  "savings_goals",
  "transaction_labels",
  "transaction_reviews",
  "transaction_sources",
  "transaction_splits",
  "transactions",
  "webhook_credentials",
];

const TRUNCATE_GRANTS: string[] = [];

// One catalogue read per privilege, keyed by every base table in `public` so a table with no
// gap at all is still compared and a table that vanished is drift, not silence.
async function columnGapMap(privilege: "INSERT" | "UPDATE"): Promise<Record<string, string[]>> {
  const rows = await sql<{ table_name: string; column_name: string; barred: boolean }[]>`
    select c.table_name, c.column_name,
      not has_column_privilege(
        'authenticated',
        ('finances.' || quote_ident(c.table_name))::regclass,
        c.column_name,
        ${privilege}) as barred
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name = c.table_name
     and t.table_type = 'BASE TABLE'
    where c.table_schema = 'finances'`;

  const map: Record<string, string[]> = {};
  for (const row of rows) {
    map[row.table_name] ??= [];
    if (row.barred) map[row.table_name].push(row.column_name);
  }
  return map;
}

// Takes the executor so the negative control can read the catalogue from inside its own
// transaction, where the grant it adds is visible and nowhere else.
async function tableGrantList(
  privilege: "DELETE" | "TRUNCATE",
  on: postgres.Sql | postgres.TransactionSql = sql,
): Promise<string[]> {
  // Materialised so the planner cannot cast another schema's view name (vault's
  // `decrypted_secrets`) to a regclass before the schema filter drops it.
  const rows = await on<{ table_name: string }[]>`
    with base as materialized (
      select t.table_name
      from information_schema.tables t
      where t.table_schema = 'finances'
        and t.table_type = 'BASE TABLE')
    select t.table_name
    from base t
    where has_table_privilege(
        'authenticated',
        ('finances.' || quote_ident(t.table_name))::regclass,
        ${privilege})
    order by t.table_name`;
  return rows.map((row) => row.table_name);
}

// Names every table that differs, so a failure says which grant moved and not merely that one did.
function compareGrantMaps(
  live: Record<string, string[]>,
  recorded: Record<string, string[]>,
): { drifted: string[]; detail: string } {
  const compared = [...new Set([...Object.keys(live), ...Object.keys(recorded)])].sort();
  const drifted = compared.filter(
    (table) =>
      JSON.stringify((live[table] ?? ["<no such table>"]).sort()) !==
      JSON.stringify((recorded[table] ?? ["<not recorded>"]).sort()),
  );

  return {
    drifted,
    detail: `compared ${compared.length} tables (${compared.join(", ")})${
      drifted.length > 0
        ? `; drifted: ${drifted
            .map(
              (table) =>
                `${table} recorded [${(recorded[table] ?? []).join(", ")}] live [${(live[table] ?? []).join(", ")}]`,
            )
            .join("; ")}`
        : ""
    }`,
  };
}

// Assertions 173-174: the two facts `insertRow` rests on — that its snake_case map
// names real columns, and that the per-column INSERT grants are still the ones the
// helper exists to satisfy. Catalogue reads only: no fixture, no write, no role switch.
async function checkInsertGrantMap() {
  console.log("");
  const tables = schemaTables();

  const live = await sql<{ table_name: string; column_name: string }[]>`
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name = c.table_name
     and t.table_type = 'BASE TABLE'
    where c.table_schema = 'finances'`;

  const realColumns = new Set(live.map((row) => `${row.table_name}.${row.column_name}`));
  const unmapped = tables.flatMap((table) =>
    table.columns
      .map((column) => `${table.name}.${column}`)
      .filter((qualified) => !realColumns.has(qualified)),
  );
  const mappedCount = tables.reduce((total, table) => total + table.columns.length, 0);

  assert(
    "173. every column name insertRow derives is a real column",
    unmapped.length === 0,
    `${tables.length} tables, ${mappedCount} columns mapped, ${unmapped.length} unmapped${
      unmapped.length > 0 ? `: ${unmapped.join(", ")}` : ""
    }`,
  );

  const inserts = compareGrantMaps(await columnGapMap("INSERT"), INSERT_GRANT_GAPS);

  assert(
    "174. the per-column INSERT grants are the ones recorded here",
    inserts.drifted.length === 0,
    inserts.detail,
  );
}

// Assertions 175-178: `insertRow` against the grants, and the Drizzle insert builder
// against the same values as the negative control — without that refusal the suite
// would pass on a database that granted INSERT on every column. Fixtures are seeded
// inside one transaction that is forced to roll back, entered with the one-statement
// settle `withUserDb` uses; each barred statement runs in its own savepoint.
async function checkInsertHelper() {
  console.log("");
  const owner = randomUUID();
  const today = "2026-01-01";
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "175. insertRow writes the account the builder is refused",
    "176. the columns insertRow omits are stamped, not lost",
    "177. insertRow writes both splits the builder is refused",
  ];
  const tailLabel =
    "178. insertRow upserts debt terms, updated_at in the SET is refused, and nothing survived";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  // `permission denied for table X` and `new row violates row-level security
  // policy` share sqlstate 42501, and only the first is the grant this suite is
  // about — so every refusal carries its message too.
  let upsertOutcome = "the transaction never ran";

  await orm
    .transaction(async (tx) => {
      await tx.execute(dsql`insert into auth.users (id) values (${owner})`);
      await tx.execute(dsql`insert into app_users (id) values (${owner})`);
      await enter(tx, owner);

      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      // 175: `createAccount`'s exact key set — the ten columns a caller sends, with
      // `id`, `created_at` and `updated_at` left to the triggers.
      const cardValues = {
        name: "RLS insert helper card",
        kind: "liability" as const,
        subtype: "bank" as const,
        ownerUserId: owner,
        groupId: null,
        isShared: false,
        institution: "Bancolombia",
        lastFour: "4321",
        initialBalanceCents: -150000,
        initialBalanceOn: today,
      };

      const [card] = await insertRow(tx, schema.accounts, cardValues, {
        returning: { id: schema.accounts.id },
      });
      const builderRefusal = await refusalOf((sp) =>
        sp.insert(schema.accounts).values(cardValues),
      );

      assert(
        labels[0],
        card?.id !== undefined &&
          builderRefusal.includes("42501") &&
          builderRefusal.includes("permission denied for table accounts"),
        `helper wrote ${card?.id ?? "nothing"}, builder ${builderRefusal}`,
      );

      // 176: the same row read back. `subtype` went in as 'bank' and comes out
      // 'card' — `set_account_subtype` follows the kind, and the helper's
      // statement reaches the trigger like any other.
      const [stamped] = await tx.execute<{
        id: string;
        created_at: Date | null;
        updated_at: Date | null;
        subtype: string;
      }>(
        dsql`select id, created_at, updated_at, subtype from accounts where id = ${card.id}`,
      );
      assert(
        labels[1],
        stamped.id === card.id &&
          stamped.created_at !== null &&
          stamped.updated_at !== null &&
          stamped.subtype === "card",
        `created_at = ${stamped.created_at !== null}, updated_at = ${stamped.updated_at !== null}, subtype = ${stamped.subtype} from 'bank'`,
      );

      // 177: two rows, one statement, against a movement of the owner's own.
      const [cash] = await tx.execute<{ id: string }>(
        dsql`insert into accounts
          (owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
          values (${owner}, 'RLS insert helper cash', 'asset', 'cash', 100000, ${today})
          returning id`,
      );
      const [category] = await tx.execute<{ id: string }>(
        dsql`insert into categories (owner_user_id, name, kind)
          values (${owner}, 'RLS insert helper spend', 'expense') returning id`,
      );
      const [movement] = await tx.execute<{ id: string }>(
        dsql`insert into transactions (from_account_id, amount_cents, occurred_at)
          values (${cash.id}, 5000, ${today}) returning id`,
      );

      const splitValues = [
        { transactionId: movement.id, categoryId: category.id, amountCents: 3000 },
        { transactionId: movement.id, categoryId: category.id, amountCents: 2000 },
      ];
      await insertRow(tx, schema.transactionSplits, splitValues);
      const [{ count: splitCount }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from transaction_splits
          where transaction_id = ${movement.id}`,
      );
      const splitBuilderRefusal = await refusalOf((sp) =>
        sp.insert(schema.transactionSplits).values(splitValues),
      );

      assert(
        labels[2],
        splitCount === "2" &&
          splitBuilderRefusal.includes("42501") &&
          splitBuilderRefusal.includes("permission denied for table transaction_splits"),
        `helper wrote ${splitCount} splits, builder ${splitBuilderRefusal}`,
      );

      // 178: the upsert `upsertDebtTerms` runs, then the same statement with
      // `updated_at` in the SET — no UPDATE grant covers that column, and Postgres
      // checks the SET privileges whether or not a row conflicts.
      const terms = {
        debtKind: "revolving" as const,
        annualRate: "0.2800",
        minimumPaymentCents: 5000,
        minimumPaymentPct: null,
        creditLimitCents: 1000000,
        statementCutOffDay: 15,
        paymentDueDay: 5,
        avalCents: null,
      };
      const upsert = (on: OrmTx, set: InsertValues<typeof schema.debtTerms>) =>
        insertRow(
          on,
          schema.debtTerms,
          { accountId: card.id, ...terms },
          { onConflict: { target: schema.debtTerms.accountId, set } },
        );

      await upsert(tx, terms);
      await upsert(tx, { ...terms, annualRate: "0.3500" });
      const [{ count: termCount, rate }] = await tx.execute<{
        count: string;
        rate: string;
      }>(
        dsql`select count(*)::text as count, max(annual_rate)::text as rate
          from debt_terms where account_id = ${card.id}`,
      );
      const stampedSetRefusal = await refusalOf((sp) =>
        upsert(sp, { ...terms, updatedAt: dsql`now()` }),
      );

      upsertOutcome = `${termCount} row at rate ${rate}, updated_at in the SET ${stampedSetRefusal}`;
      const upsertHeld =
        termCount === "1" &&
        Number(rate) === 0.35 &&
        stampedSetRefusal.includes("42501") &&
        stampedSetRefusal.includes("permission denied for table debt_terms");

      // Nothing this section wrote may survive; force the ROLLBACK.
      if (!upsertHeld) upsertOutcome = `${upsertOutcome} — not what was expected`;
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`
    select current_user`;
  const [survivors] = await sql<{ accounts: string; terms: string }[]>`
    select
      (select count(*)::text from accounts
        where name like 'RLS insert helper%') as accounts,
      (select count(*)::text from debt_terms t
        join accounts a on a.id = t.account_id
        where a.name like 'RLS insert helper%') as terms`;

  assert(
    tailLabel,
    upsertOutcome.includes("permission denied for table debt_terms") &&
      !upsertOutcome.includes("not what was expected") &&
      afterUser === "postgres" &&
      survivors.accounts === "0" &&
      survivors.terms === "0",
    `${upsertOutcome}; current_user = ${afterUser}, accounts surviving = ${survivors.accounts}, terms surviving = ${survivors.terms}`,
  );
}

// Assertions 179-183: the `user_id` lock on group_members. `grant update (user_id, invite_email)`
// served the invite claim, but a grant spans every UPDATE policy on the table, and
// `group_members_update_member` admits every row in the group: a plain member could repoint the
// leader's `user_id` at a second account of his own, evicting her and inheriting the group with the
// `role = 'leader'` the row keeps. The attack is executed here, not read off the policy text.
// Fixtures live in one transaction forced to roll back; each barred statement runs in its own savepoint.
async function checkGroupMemberUserIdLock() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  // The attacker's second sign-up: a real row, since `user_id` carries a foreign key.
  const strangerUser = randomUUID();
  const memberEmail = `member-${randomUUID()}@example.test`;
  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "179. the invited caller's claim joins nobody and leaves the pending row alone (RF-154)",
    "180. a second claim by the same caller returns null",
    "181. a plain member cannot repoint the leader's user_id at an account of his own",
    "182. a plain member still renames their own row",
  ];
  const tailLabel = "183. the rolled-back escalation transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string, email?: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated", ...(email ? { email } : {}) })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(
        dsql`insert into auth.users (id) values (${leaderUser}), (${memberUser}), (${strangerUser})`,
      );
      await tx.execute(
        dsql`insert into app_users (id) values (${leaderUser}), (${memberUser}), (${strangerUser})`,
      );

      // The leader opens the group and records the person she invites by email (RF-07).
      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls escalation', 'shared')`,
      );
      const [leaderRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls escalation leader', 'leader') returning id`,
      );
      const [pending] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, name, role, invite_email)
          values (${groupId}, 'rls escalation member', 'member', ${memberEmail}) returning id`,
      );

      // 179: the claim takes no argument, so the caller cannot aim it: the function reads auth.email()
      // and picks the oldest pending row addressed to it.
      await tx.execute(dsql`reset role`);
      await enter(tx, memberUser, memberEmail);
      const [{ claim_group_invite: claimedId }] = await tx.execute<{
        claim_group_invite: string | null;
      }>(dsql`select private.claim_group_invite()`);
      const [claimedRow] = await tx.execute<{
        user_id: string | null;
        invite_email: string | null;
        role: string;
      }>(dsql`select user_id, invite_email, role from group_members where id = ${pending.id}`);
      assert(
        labels[0],
        claimedId === null && claimedRow === undefined,
        `claim returned ${claimedId ?? "null"}, row visible to the caller = ${claimedRow ? "yes" : "no"}`,
      );

      // The acceptance M68 writes, run as the owner so 181 and 182 keep a member to attack with.
      await tx.execute(dsql`reset role`);
      await tx.execute(
        dsql`update group_members set user_id = ${memberUser}, invite_email = null, invite_state = 'accepted'
          where id = ${pending.id}`,
      );
      await enter(tx, memberUser, memberEmail);

      // 180: nothing pends on that email any more, so the same call claims nothing.
      const [{ claim_group_invite: repeatId }] = await tx.execute<{
        claim_group_invite: string | null;
      }>(dsql`select private.claim_group_invite()`);
      assert(labels[1], repeatId === null, `returned ${repeatId ?? "null"}`);

      // 181: the escalation itself, run as the plain member it was proved with. Before the grant was
      // narrowed this returned UPDATE 1 and left `role = 'leader'` on a row pointing at the stranger.
      let attackRows = -1;
      const attackRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`update group_members set user_id = ${strangerUser}
            where id = ${leaderRow.id} returning id`,
        );
        attackRows = rows.length;
      });
      const [leaderNow] = await tx.execute<{ user_id: string | null; role: string }>(
        dsql`select user_id, role from group_members where id = ${leaderRow.id}`,
      );
      assert(
        labels[2],
        (attackRows === 0 || attackRefusal.includes("42501")) &&
          leaderNow.user_id === leaderUser &&
          leaderNow.role === "leader",
        `rows = ${attackRows === -1 ? "none issued" : attackRows}, ${attackRefusal}, leader row user_id = ${leaderNow?.user_id === leaderUser ? "still hers" : leaderNow?.user_id}, role = ${leaderNow?.role}`,
      );

      // 182: the negative control — the fix narrowed the grant, it did not withdraw the feature.
      const renamed = await tx.execute<{ id: string; name: string }>(
        dsql`update group_members set name = 'rls escalation renamed'
          where id = ${pending.id} returning id, name`,
      );
      assert(
        labels[3],
        renamed.length === 1 && renamed[0].name === "rls escalation renamed",
        `renamed ${renamed.length} row to '${renamed[0]?.name}'`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls escalation%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls escalation%' = ${probeCount}`,
  );
}

// Assertions 184-190: RF-100. `group_members_update_member` used `is_group_member` in its USING and a
// WITH CHECK that admitted any row but the caller's own, and `group_members_delete_member` the same,
// so a plain member archived and removed every other member — the leader's row answered `UPDATE 1`
// and `DELETE 1` on the live database, with only the deferred `assert_group_keeps_leader` between a
// group and no leader at all. Both attacks are executed here, then the two negative controls that say
// the feature survived. Fixtures live in one transaction forced to roll back; each barred statement
// runs in its own savepoint.
async function checkMemberManagementLeaderOnly() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "184. a plain member's archive of the leader's row touches nothing",
    "185. a plain member's delete of the leader's row touches nothing",
    "186. a plain member cannot add a member",
    "187. a plain member still renames their own row",
    "188. the leader still adds, archives and removes a member",
    "189. a member the leader archived cannot restore herself",
  ];
  const tailLabel = "190. the rolled-back member management transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${leaderUser}), (${memberUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${leaderUser}), (${memberUser})`);

      // The leader opens the group and records two people with no login: one for her to archive, one
      // for her to remove. The plain member's own row carries a login, which no policy hands out, so
      // it is seeded as `postgres`.
      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls member mgmt', 'shared')`,
      );
      const [leaderRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls member mgmt leader', 'leader') returning id`,
      );
      const [toArchive] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, name, role)
          values (${groupId}, 'rls member mgmt archivable', 'member') returning id`,
      );
      const [toRemove] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, name, role)
          values (${groupId}, 'rls member mgmt removable', 'member') returning id`,
      );
      await tx.execute(dsql`reset role`);
      const [memberRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${memberUser}, 'rls member mgmt member', 'member') returning id`,
      );

      await enter(tx, memberUser);

      // 184: the archive attack. Before the policies were narrowed this answered UPDATE 1 and left the
      // leader out of her own group on the next request.
      let archiveRows = -1;
      const archiveRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`update group_members set archived_at = now() where id = ${leaderRow.id} returning id`,
        );
        archiveRows = rows.length;
      });
      const [leaderAfterArchive] = await tx.execute<{ archived_at: string | null }>(
        dsql`select archived_at::text from group_members where id = ${leaderRow.id}`,
      );
      assert(
        labels[0],
        (archiveRows === 0 || archiveRefusal.includes("42501")) &&
          leaderAfterArchive.archived_at === null,
        `rows = ${archiveRows === -1 ? "none issued" : archiveRows}, ${archiveRefusal}, leader archived_at = ${leaderAfterArchive?.archived_at ?? "null"}`,
      );

      // 185: the delete attack. It answered DELETE 1, and only the deferred keep-leader trigger stood
      // between the group and no leader — and it stands for the last leader alone.
      let deleteRows = -1;
      const deleteRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`delete from group_members where id = ${leaderRow.id} returning id`,
        );
        deleteRows = rows.length;
      });
      const [{ count: leaderSurvives }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from group_members where id = ${leaderRow.id}`,
      );
      assert(
        labels[1],
        (deleteRows === 0 || deleteRefusal.includes("42501")) && leaderSurvives === "1",
        `rows = ${deleteRows === -1 ? "none issued" : deleteRows}, ${deleteRefusal}, leader rows surviving = ${leaderSurvives}`,
      );

      // 186: an INSERT has no USING to filter it, so the refusal is the WITH CHECK itself.
      const insertRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into group_members (group_id, name, role)
            values (${groupId}, 'rls member mgmt smuggled', 'member')`,
        ),
      );
      const [{ count: smuggled }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from group_members
          where group_id = ${groupId} and name = 'rls member mgmt smuggled'`,
      );
      assert(
        labels[2],
        insertRefusal.includes("42501") && smuggled === "0",
        `${insertRefusal}, rows landed = ${smuggled}`,
      );

      // 187: the first negative control — every member keeps their own name (RF-100).
      const renamed = await tx.execute<{ id: string; name: string }>(
        dsql`update group_members set name = 'rls member mgmt renamed'
          where id = ${memberRow.id} returning id, name`,
      );
      assert(
        labels[3],
        renamed.length === 1 && renamed[0].name === "rls member mgmt renamed",
        `renamed ${renamed.length} row to '${renamed[0]?.name}'`,
      );

      // 188: the second negative control — the leader keeps the whole feature.
      await tx.execute(dsql`reset role`);
      await enter(tx, leaderUser);
      const added = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, name, role)
          values (${groupId}, 'rls member mgmt added', 'member') returning id`,
      );
      const archived = await tx.execute<{ archived_at: string | null }>(
        dsql`update group_members set archived_at = now()
          where id = ${toArchive.id} returning archived_at::text`,
      );
      const removed = await tx.execute<{ id: string }>(
        dsql`delete from group_members where id = ${toRemove.id} returning id`,
      );
      assert(
        labels[4],
        added.length === 1 &&
          archived.length === 1 &&
          archived[0].archived_at !== null &&
          removed.length === 1,
        `added ${added.length}, archived ${archived.length} at ${archived[0]?.archived_at ?? "nothing"}, removed ${removed.length}`,
      );

      // 189: restoring is the leader's too, and the caller's own row is the one exception the update
      // policy carries — so the USING drops it once it is archived, or an eviction would undo itself.
      await tx.execute(
        dsql`update group_members set archived_at = now() where id = ${memberRow.id}`,
      );
      await tx.execute(dsql`reset role`);
      await enter(tx, memberUser);
      let restoreRows = -1;
      const restoreRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`update group_members set archived_at = null
            where id = ${memberRow.id} returning id`,
        );
        restoreRows = rows.length;
      });
      await tx.execute(dsql`reset role`);
      const [selfNow] = await tx.execute<{ archived_at: string | null }>(
        dsql`select archived_at::text from group_members where id = ${memberRow.id}`,
      );
      assert(
        labels[5],
        (restoreRows === 0 || restoreRefusal.includes("42501")) && selfNow.archived_at !== null,
        `rows = ${restoreRows === -1 ? "none issued" : restoreRows}, ${restoreRefusal}, own archived_at = ${selfNow?.archived_at ?? "null"}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls member mgmt%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls member mgmt%' = ${probeCount}`,
  );
}

// Assertions 191-192: the default privileges that reach `finances`, where this app's tables
// live. Supabase attaches its own to `public` alone, so a table born here inherits nothing —
// which is the point, and has to stay true. Every table here
// clears them with an explicit REVOKE ALL, so nothing is exposed — but the next CREATE TABLE that
// forgets one hands `authenticated` TRUNCATE, which consults no policy and fires no row trigger:
// the table empties and `capture_audit` records nothing (RF-45). The second assertion creates a
// table inside a transaction forced to roll back and reads what the catalogue attached to it.
async function checkDefaultPrivileges() {
  console.log("");
  const probeTable = `default_acl_probe_${randomUUID().replace(/-/g, "")}`;
  const forcedRollback = Symbol("forced rollback");

  const handouts = await sql<{ objtype: string; role: string; priv: string }[]>`
    select d.defaclobjtype::text as objtype, a.grantee::regrole::text as role,
      a.privilege_type as priv
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole = 'postgres'::regrole
      and d.defaclnamespace = 'finances'::regnamespace
      and a.grantee::regrole::text in ('anon', 'authenticated', 'service_role')
    order by d.defaclobjtype, a.grantee::regrole::text, a.privilege_type`;

  assert(
    "191. no default privilege in public hands the client roles anything",
    handouts.length === 0,
    handouts.length === 0
      ? "pg_default_acl for postgres in public grants none of the three roles a privilege"
      : `${handouts.length} handouts: ${handouts
          .map((row) => `${row.objtype}:${row.role}:${row.priv}`)
          .join(", ")}`,
  );

  let attached = "the transaction never ran";
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`create table finances.${probeTable} (id int)`);
      const granted = await tx<{ role: string; priv: string }[]>`
        select a.grantee::regrole::text as role, a.privilege_type as priv
        from pg_class c
        cross join lateral aclexplode(c.relacl) a
        where c.oid = ${`finances.${probeTable}`}::regclass
          and a.grantee::regrole::text in ('anon', 'authenticated', 'service_role')
        order by a.grantee::regrole::text, a.privilege_type`;
      attached =
        granted.length === 0
          ? "no privilege at all"
          : granted.map((row) => `${row.role}:${row.priv}`).join(", ");
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ still }] = await sql<{ still: string | null }[]>`
    select to_regclass(${`finances.${probeTable}`})::text as still`;

  assert(
    "192. a table created now inherits nothing for the client roles",
    attached === "no privilege at all" && still === null,
    `a fresh table gave the three roles ${attached}; the probe table after the rollback = ${still ?? "gone"}`,
  );
}

// Assertions 193-197: the grants that slipped outside the per-column discipline. `goal_progress`
// revoked from three roles and left `authenticated` holding the default TRUNCATE, REFERENCES and
// TRIGGER on top of its SELECT; `app_users` and `group_members` granted INSERT table-wide, so a
// caller stamped their own `created_at` where every other table leaves it to a trigger. Fixtures
// live in one transaction forced to roll back; each barred statement runs in its own savepoint.
async function checkSlippedGrants() {
  console.log("");
  const owner = randomUUID();
  const leaderUser = randomUUID();
  const groupId = randomUUID();
  const forgedAt = "2000-01-01T00:00:00Z";
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "193. authenticated holds SELECT and nothing else on goal_progress",
    "194. app_users refuses a forged created_at and stamps its own",
    "195. the caller still writes their locale, and updated_at in the SET is refused",
    "196. group_members refuses a forged created_at and stamps its own",
  ];
  const tailLabel = "197. the rolled-back slipped-grant transaction leaves no trace";

  const viewGrants = await sql<{ priv: string }[]>`
    select a.privilege_type as priv
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
    where c.oid = 'finances.goal_progress'::regclass
      and a.grantee = 'authenticated'::regrole
    order by a.privilege_type`;

  const held = viewGrants.map((row) => row.priv);
  assert(
    labels[0],
    held.length === 1 && held[0] === "SELECT",
    `holds [${held.join(", ")}]`,
  );

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      // The savepoint is discarded whether or not the statement was refused, so a forged write
      // that is not yet barred leaves no row for the statement after it to collide with.
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        const discard = Symbol("discard the savepoint");
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
            throw discard;
          })
          .catch((error: unknown) => {
            if (error !== discard) refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${owner}), (${leaderUser})`);

      // 194: the caller's own sign-in row, which no seed precedes — `app_users_insert_self` is the
      // one policy a session leans on before it has any other row at all.
      await enter(tx, owner);
      const forgedInsert = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into app_users (id, created_at) values (${owner}, ${forgedAt}::timestamptz)`,
        ),
      );
      await tx.execute(dsql`insert into app_users (id, locale) values (${owner}, 'es')`);
      const [born] = await tx.execute<{ forged: boolean; stamped: boolean }>(
        dsql`select created_at = ${forgedAt}::timestamptz as forged, created_at is not null as stamped
          from app_users where id = ${owner}`,
      );
      assert(
        labels[1],
        forgedInsert.includes("42501") &&
          forgedInsert.includes("permission denied for table app_users") &&
          born.forged === false &&
          born.stamped,
        `${forgedInsert}; the row that landed carries the forged timestamp = ${born?.forged}, stamped = ${born?.stamped}`,
      );

      // 195: the negative control on the same table — narrowing the grant may not cost the caller
      // the locale switch `upsertUserLocale` runs on every language change.
      const relocated = await tx.execute<{ locale: string }>(
        dsql`update app_users set locale = 'en' where id = ${owner} returning locale`,
      );
      const stampedSetRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`update app_users set locale = 'es', updated_at = now() where id = ${owner}`,
        ),
      );
      assert(
        labels[2],
        relocated.length === 1 &&
          relocated[0].locale === "en" &&
          stampedSetRefusal.includes("42501") &&
          stampedSetRefusal.includes("permission denied for table app_users"),
        `wrote locale = ${relocated[0]?.locale ?? "nothing"}, updated_at in the SET ${stampedSetRefusal}`,
      );

      // 196: the same on the one table that carried a table-wide INSERT, from the leader who is the
      // only caller `group_members_insert_member` admits.
      await tx.execute(dsql`reset role`);
      await tx.execute(dsql`insert into app_users (id) values (${leaderUser})`);
      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls slipped grants', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls slipped grants leader', 'leader')`,
      );
      const forgedMember = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into group_members (group_id, name, role, created_at)
            values (${groupId}, 'rls slipped grants forged', 'member', ${forgedAt}::timestamptz)`,
        ),
      );
      const [invited] = await tx.execute<{ forged: boolean; stamped: boolean }>(
        dsql`insert into group_members (group_id, name, role)
          values (${groupId}, 'rls slipped grants invited', 'member')
          returning created_at = ${forgedAt}::timestamptz as forged, created_at is not null as stamped`,
      );
      assert(
        labels[3],
        forgedMember.includes("42501") &&
          forgedMember.includes("permission denied for table group_members") &&
          invited.forged === false &&
          invited.stamped,
        `${forgedMember}; the row that landed carries the forged timestamp = ${invited?.forged}, stamped = ${invited?.stamped}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls slipped grants%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls slipped grants%' = ${probeCount}`,
  );
}

// Assertions 198-201: `GRANT UPDATE (name, cash_mode)` stood on `groups` since the first migration
// with no UPDATE policy behind it, so a leader's rename answered UPDATE 0 and the name chosen at
// creation was the only one the group would ever have. RF-121 added `currency` to that grant, so
// where the fund settles is now the leader's to change. Rename and re-currency are executed here as
// the leader and as a plain member. Fixtures live in one transaction forced to roll back; each
// barred statement runs in its own savepoint.
async function checkGroupUpdatePolicy() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "198. the leader renames her own group",
    "199. a plain member's rename of the group touches nothing",
    "200. the leader rewrites the group's currency and a plain member's identical statement touches no row",
  ];
  const tailLabel = "201. the rolled-back group rename transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${leaderUser}), (${memberUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${leaderUser}), (${memberUser})`);

      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls group rename', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls group rename leader', 'leader')`,
      );
      // A member's row carries a login, which no policy hands out, so it is seeded as `postgres`.
      await tx.execute(dsql`reset role`);
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${memberUser}, 'rls group rename member', 'member')`,
      );

      // 198: before the policy landed this returned UPDATE 0 against a grant no policy served.
      await enter(tx, leaderUser);
      const renamed = await tx.execute<{ name: string }>(
        dsql`update groups set name = 'rls group rename taken' where id = ${groupId} returning name`,
      );
      assert(
        labels[0],
        renamed.length === 1 && renamed[0].name === "rls group rename taken",
        `renamed ${renamed.length} row to '${renamed[0]?.name}'`,
      );

      // 200, first half: the leader's re-currency, written as `updateGroupSettings` would write it.
      const reCurrencied = await tx.execute<{ currency: string }>(
        dsql`update groups set currency = 'USD' where id = ${groupId} returning currency`,
      );

      // 199: the USING is what keeps the rename the leader's — the member holds the same grant.
      await tx.execute(dsql`reset role`);
      await enter(tx, memberUser);
      let memberRows = -1;
      const memberRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`update groups set name = 'rls group rename seized' where id = ${groupId} returning id`,
        );
        memberRows = rows.length;
      });
      const [{ name: nameNow }] = await tx.execute<{ name: string }>(
        dsql`select name from groups where id = ${groupId}`,
      );
      assert(
        labels[1],
        (memberRows === 0 || memberRefusal.includes("42501")) &&
          nameNow === "rls group rename taken",
        `rows = ${memberRows === -1 ? "none issued" : memberRows}, ${memberRefusal}, name = '${nameNow}'`,
      );

      // 200, second half: the member holds the very same column grant, so the statement is admitted
      // and `groups_update_leader`'s USING matches no row. What she gets back is silence — zero rows
      // and no sqlstate — which is the whole of the authorisation here.
      let memberCurrencyRows = -1;
      const memberCurrencyRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`update groups set currency = 'EUR' where id = ${groupId} returning id`,
        );
        memberCurrencyRows = rows.length;
      });
      // Read as the owner: the assertion is about what the row STORES, not what the member is shown.
      await tx.execute(dsql`reset role`);
      const [{ currency }] = await tx.execute<{ currency: string }>(
        dsql`select currency from groups where id = ${groupId}`,
      );
      assert(
        labels[2],
        reCurrencied.length === 1 &&
          reCurrencied[0].currency === "USD" &&
          memberCurrencyRows === 0 &&
          memberCurrencyRefusal.startsWith("no refusal") &&
          currency === "USD",
        `leader wrote ${reCurrencied.length} row to ${reCurrencied[0]?.currency}, member wrote ${memberCurrencyRows === -1 ? "none issued" : memberCurrencyRows} (${memberCurrencyRefusal}), currency = ${currency}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls group rename%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls group rename%' = ${probeCount}`,
  );
}

// Assertions 202-205: assertion 174 pinned INSERT columns alone, so a slipped UPDATE, DELETE or
// TRUNCATE grant went green — which is how `goal_progress` and the default privileges lasted until
// a person read the catalogue. The same comparison now runs on the other three privileges, and the
// last assertion adds a DELETE grant inside a transaction forced to roll back to show the
// comparison can go red at all. Catalogue reads only: no fixture, no role switch, no write that survives.
async function checkWriteGrantMap() {
  console.log("");
  const updates = compareGrantMaps(await columnGapMap("UPDATE"), UPDATE_GRANT_GAPS);

  assert(
    "202. the per-column UPDATE grants are the ones recorded here",
    updates.drifted.length === 0,
    updates.detail,
  );

  const deletes = await tableGrantList("DELETE");
  const deleteDrift = [
    ...deletes.filter((table) => !DELETE_GRANTS.includes(table)).map((table) => `+${table}`),
    ...DELETE_GRANTS.filter((table) => !deletes.includes(table)).map((table) => `-${table}`),
  ];

  assert(
    "203. the table-level DELETE grants are the ones recorded here",
    deleteDrift.length === 0,
    `${deletes.length} tables grant DELETE${deleteDrift.length > 0 ? `; drifted: ${deleteDrift.join(", ")}` : ""}`,
  );

  const truncates = await tableGrantList("TRUNCATE");
  assert(
    "204. no table in public grants authenticated TRUNCATE",
    truncates.length === TRUNCATE_GRANTS.length && truncates.length === 0,
    `${truncates.length} tables grant TRUNCATE${truncates.length > 0 ? `: ${truncates.join(", ")}` : ""}`,
  );

  // The control: without it these three assertions would pass on a catalogue read that returned
  // the recorded list by construction.
  const forcedRollback = Symbol("forced rollback");
  let seeded: string[] = [];
  await sql
    .begin(async (tx) => {
      await tx`grant delete on table groups to authenticated`;
      seeded = await tableGrantList("DELETE", tx);
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const after = await tableGrantList("DELETE");
  assert(
    "205. a DELETE grant added inside the control transaction is reported as drift",
    seeded.includes("groups") &&
      !DELETE_GRANTS.includes("groups") &&
      !after.includes("groups") &&
      after.length === DELETE_GRANTS.length,
    `inside the transaction ${seeded.length} tables granted DELETE including groups; after the rollback ${after.length}, groups included = ${after.includes("groups")}`,
  );
}

// Assertions 206-209: RF-101. `num_nonnulls(from_account_id, to_account_id) >= 1` counted the accounts
// and never compared them, so a movement naming one account on both sides committed, took
// `kind = 'transfer'` from the generated column and entered the ledger as a real entry netting zero —
// one row returned on the live database. The pair is executed here, then the two legal shapes it must
// not have cost. Fixtures live in one transaction forced to roll back; each barred statement runs in
// its own savepoint.
async function checkSelfTransferRefused() {
  console.log("");
  const owner = randomUUID();
  const today = "2026-01-01";
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "206. a movement naming one account on both sides is refused",
    "207. a planned payment naming one account on both sides is refused",
    "208. a transfer between two different accounts and a one-sided income still land",
  ];
  const tailLabel = "209. the rolled-back self-transfer transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${owner})`);
      await tx.execute(dsql`insert into app_users (id) values (${owner})`);
      await enter(tx, owner);

      const [bank] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
          values (${owner}, 'rls self transfer bank', 'asset', 500000, ${today}) returning id`,
      );
      const [cash] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
          values (${owner}, 'rls self transfer cash', 'asset', 100000, ${today}) returning id`,
      );

      // 206: the entry that netted zero. `is distinct from` is what refuses it, so the message names
      // the constraint and not a policy.
      const selfRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
            values (${bank.id}, ${bank.id}, 500000, ${today})`,
        ),
      );
      assert(
        labels[0],
        selfRefusal.includes("23514") &&
          selfRefusal.includes("transactions_accounts_distinct"),
        selfRefusal,
      );

      // 207: the deferred twin carried the identical `num_nonnulls` shape.
      const plannedRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into planned_payments (from_account_id, to_account_id, amount_cents, due_date)
            values (${bank.id}, ${bank.id}, 500000, ${today})`,
        ),
      );
      assert(
        labels[1],
        plannedRefusal.includes("23514") &&
          plannedRefusal.includes("planned_payments_accounts_distinct"),
        plannedRefusal,
      );

      // 208: the negative control — the fix refuses one pair, it does not withdraw the transfer.
      const transfer = await tx.execute<{ id: string; kind: string }>(
        dsql`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
          values (${bank.id}, ${cash.id}, 200000, ${today}) returning id, kind`,
      );
      const income = await tx.execute<{ id: string; kind: string }>(
        dsql`insert into transactions (to_account_id, amount_cents, occurred_at)
          values (${bank.id}, 300000, ${today}) returning id, kind`,
      );
      assert(
        labels[2],
        transfer.length === 1 &&
          transfer[0].kind === "transfer" &&
          income.length === 1 &&
          income[0].kind === "income",
        `transfer landed ${transfer.length} row as ${transfer[0]?.kind}, income landed ${income.length} row as ${income[0]?.kind}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls self transfer%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls self transfer%' = ${probeCount}`,
  );
}

// Assertions 210-214 and 282: RF-63's two written clauses, "a subcategory shares its parent's scope"
// and "one level of subcategories". The composite foreign key on `(parent_id, group_id)` is MATCH
// SIMPLE, so it is not evaluated at all when `group_id` is null — every personal category — and
// `assert_category_depth` checked self-reference, depth and kind and never scope. A personal category
// naming a group category, and one naming a uuid held by no row, each landed on the live database, and
// the picker then dropped them in silence. Both are executed here, then the two subcategories the app
// actually writes, then the grandchild it must never write. Fixtures live in one transaction forced to
// roll back; each barred statement runs in its own savepoint.
async function checkCategoryParentScope() {
  console.log("");
  const leaderUser = randomUUID();
  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "210. a personal category naming a group category as parent is refused",
    "211. a category naming a parent held by no row is refused",
    "212. a personal subcategory of its owner's own parent lands",
    "213. a group subcategory of that group's parent lands",
    "282. a subcategory of a subcategory is refused",
  ];
  const tailLabel = "214. the rolled-back category-scope transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${leaderUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${leaderUser})`);
      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls category scope', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls category scope leader', 'leader')`,
      );

      const [groupParent] = await tx.execute<{ id: string }>(
        dsql`insert into categories (group_id, name, kind)
          values (${groupId}, 'rls category scope group parent', 'expense') returning id`,
      );
      const [ownParent] = await tx.execute<{ id: string }>(
        dsql`insert into categories (owner_user_id, name, kind)
          values (${leaderUser}, 'rls category scope own parent', 'expense') returning id`,
      );

      // 210: the group's category, named as parent by a personal one. Both are the caller's to write,
      // which is why no policy ever stood in the way.
      const crossRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into categories (owner_user_id, parent_id, name, kind)
            values (${leaderUser}, ${groupParent.id}, 'rls category scope escapee', 'expense')`,
        ),
      );
      assert(
        labels[0],
        crossRefusal.includes("23514") && crossRefusal.includes("scope"),
        crossRefusal,
      );

      // 211: MATCH SIMPLE skipped existence too, so the parent need not have been a row at all.
      const ghostRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into categories (owner_user_id, parent_id, name, kind)
            values (${leaderUser}, ${randomUUID()}, 'rls category scope ghost', 'expense')`,
        ),
      );
      assert(
        labels[1],
        ghostRefusal.includes("23514") && ghostRefusal.includes("does not exist"),
        ghostRefusal,
      );

      // 212, 213: the negative controls — one level of subcategory still saves, in either scope.
      const ownChild = await tx.execute<{ id: string }>(
        dsql`insert into categories (owner_user_id, parent_id, name, kind)
          values (${leaderUser}, ${ownParent.id}, 'rls category scope own child', 'expense') returning id`,
      );
      assert(labels[2], ownChild.length === 1, `landed ${ownChild.length} row`);

      const groupChild = await tx.execute<{ id: string }>(
        dsql`insert into categories (group_id, parent_id, name, kind)
          values (${groupId}, ${groupParent.id}, 'rls category scope group child', 'expense') returning id`,
      );
      assert(labels[3], groupChild.length === 1, `landed ${groupChild.length} row`);

      // 282: RF-63's other written clause, "one level of subcategories". `assert_category_depth` has
      // raised on a grandchild since 0000, and nothing ever drove it: 212 and 213 prove a child lands
      // and say nothing about what stops the next one. The number is the next free one, not a gap.
      const grandchildRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into categories (owner_user_id, parent_id, name, kind)
            values (${leaderUser}, ${ownChild[0].id}, 'rls category scope grandchild', 'expense')`,
        ),
      );
      assert(
        labels[4],
        grandchildRefusal.includes("23514") && grandchildRefusal.includes("one level"),
        grandchildRefusal,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from categories where name like 'rls category scope%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls category scope%' = ${probeCount}`,
  );
}

// Assertions 381-388: RF-63's delete, "a subcategory goes with its parent", in both scopes. The
// composite key is MATCH SIMPLE, so with `group_id` null it never cascades: a personal parent went
// alone and left its subcategory naming a row that no longer exists, while a fund parent took its
// subcategory with it or, when that subcategory was in use, refused with 23503. Both scopes are driven
// here as the person who deletes, and the cascaded row's audit trail and the catalogue are read as
// `postgres`. Fixtures live in one transaction forced to roll back; each delete runs in its own savepoint.
async function checkSubcategoryFollowsParent() {
  console.log("");
  const ownerUser = randomUUID();
  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "381. deleting a personal parent deletes its subcategory",
    "382. deleting a personal parent whose subcategory carries a split is refused with 23503 and deletes nothing",
    "383. deleting a personal parent whose subcategory a budget names is refused with 23503 and deletes nothing",
    "384. deleting a fund parent still deletes its subcategory",
    "385. deleting a fund parent whose subcategory carries a split is still refused with 23503 and deletes nothing",
    "386. the cascaded personal subcategory's delete writes one audit row scoped to its owner",
    "387. the catalogue carries the single-column parent key with ON DELETE CASCADE beside the unchanged composite key",
  ];
  const tailLabel = "388. the rolled-back subcategory-cascade transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };
      // A delete expected to land still runs in a savepoint, so a refusal reads as a FAIL and not an abort.
      const deletedBy = async (parent: string): Promise<string> => {
        let outcome = "";
        await tx
          .transaction(async (sp) => {
            const rows = await sp.execute<{ id: string }>(
              dsql`delete from categories where id = ${parent} returning id`,
            );
            outcome = `${rows.length} row`;
          })
          .catch((error: unknown) => {
            outcome = describeRefusal(error);
          });
        return outcome;
      };
      // Read past RLS, then hand the session back to the person: a row the policies hide must still count.
      const asPostgres = async <T>(read: () => Promise<T>): Promise<T> => {
        await tx.execute(dsql`reset role`);
        const result = await read();
        await enter(tx, ownerUser);
        return result;
      };
      const rowsHeld = (ids: string[]) =>
        asPostgres(async () => {
          const rows = await tx.execute<{ id: string }>(
            dsql`select id from categories where id in (${dsql.join(ids.map((id) => dsql`${id}`), dsql`, `)})`,
          );
          return rows.length;
        });

      await tx.execute(dsql`insert into auth.users (id) values (${ownerUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${ownerUser})`);
      await enter(tx, ownerUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls subcategory cascade', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${ownerUser}, 'rls subcategory cascade leader', 'leader')`,
      );
      const [ownAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_on)
          values (${ownerUser}, 'rls subcategory cascade own cash', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );
      const [fundAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
          values (${groupId}, true, 'rls subcategory cascade fund cash', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );

      // One parent and one subcategory per scenario, so no delete leans on another's outcome.
      const pair = async (scope: "own" | "fund", tag: string) => {
        const scopeColumn = scope === "own" ? dsql`owner_user_id` : dsql`group_id`;
        const scopeValue = scope === "own" ? ownerUser : groupId;
        const [parent] = await tx.execute<{ id: string }>(
          dsql`insert into categories (${scopeColumn}, name, kind)
            values (${scopeValue}, ${`rls subcategory cascade ${tag} parent`}, 'expense') returning id`,
        );
        const [child] = await tx.execute<{ id: string }>(
          dsql`insert into categories (${scopeColumn}, parent_id, name, kind)
            values (${scopeValue}, ${parent.id}, ${`rls subcategory cascade ${tag} child`}, 'expense') returning id`,
        );
        return { parent: parent.id, child: child.id };
      };
      const splitOn = async (account: string, category: string) => {
        const [movement] = await tx.execute<{ id: string }>(
          dsql`insert into transactions (from_account_id, amount_cents, occurred_at)
            values (${account}, 1500, (now() at time zone 'America/Bogota')::date) returning id`,
        );
        const [split] = await tx.execute<{ id: string }>(
          dsql`insert into transaction_splits (transaction_id, category_id, amount_cents)
            values (${movement.id}, ${category}, 1500) returning id`,
        );
        return { movement: movement.id, split: split.id };
      };

      // 381, 386: the bare cascade, then what the trail kept of the row the cascade removed.
      const bare = await pair("own", "bare");
      const bareDeleted = await deletedBy(bare.parent);
      const bareChildHeld = await rowsHeld([bare.child]);
      assert(
        labels[0],
        bareDeleted === "1 row" && bareChildHeld === 0,
        `delete returned ${bareDeleted}, the subcategory holds ${bareChildHeld} row`,
      );
      const childTrail = await asPostgres(() =>
        tx.execute<{ owner_user_id: string | null }>(
          dsql`select owner_user_id from audit_log
            where entity = 'categories' and record_id = ${bare.child} and action = 'DELETE'`,
        ),
      );
      assert(
        labels[5],
        childTrail.length === 1 && childTrail[0].owner_user_id === ownerUser,
        `DELETE audit rows for the subcategory = ${childTrail.length}, owner_user_id = ${childTrail[0]?.owner_user_id ?? "none"}`,
      );

      // 382: a split on the subcategory holds the parent, as it holds a fund parent.
      const spent = await pair("own", "spent");
      const spentSplit = await splitOn(ownAccount.id, spent.child);
      const spentRefusal = await refusalOf((sp) =>
        sp.execute(dsql`delete from categories where id = ${spent.parent}`),
      );
      const spentHeld = await rowsHeld([spent.parent, spent.child]);
      const [spentSplitAfter] = await asPostgres(() =>
        tx.execute<{ category_id: string; amount_cents: string; transaction_id: string }>(
          dsql`select category_id, amount_cents::text as amount_cents, transaction_id
            from transaction_splits where id = ${spentSplit.split}`,
        ),
      );
      assert(
        labels[1],
        spentRefusal.includes("23503") &&
          spentHeld === 2 &&
          spentSplitAfter?.category_id === spent.child &&
          spentSplitAfter?.amount_cents === "1500" &&
          spentSplitAfter?.transaction_id === spentSplit.movement,
        `${spentRefusal}; parent and subcategory hold ${spentHeld} of 2 rows; split category = ${spentSplitAfter?.category_id ?? "gone"}, amount = ${spentSplitAfter?.amount_cents ?? "gone"}`,
      );

      // 383: the second referrer, a budget, holds it the same way.
      const budgeted = await pair("own", "budgeted");
      await tx.execute(
        dsql`insert into budgets (owner_user_id, category_id, period, limit_cents, threshold_pct)
          values (${ownerUser}, ${budgeted.child}, 'monthly', 100000, 80)`,
      );
      const budgetedRefusal = await refusalOf((sp) =>
        sp.execute(dsql`delete from categories where id = ${budgeted.parent}`),
      );
      const budgetedHeld = await rowsHeld([budgeted.parent, budgeted.child]);
      assert(
        labels[2],
        budgetedRefusal.includes("23503") && budgetedHeld === 2,
        `${budgetedRefusal}; parent and subcategory hold ${budgetedHeld} of 2 rows`,
      );

      // 384, 385: the fund's answers, which the personal ones above must now equal.
      const fundBare = await pair("fund", "fund bare");
      const fundBareDeleted = await deletedBy(fundBare.parent);
      const fundBareHeld = await rowsHeld([fundBare.parent, fundBare.child]);
      assert(
        labels[3],
        fundBareDeleted === "1 row" && fundBareHeld === 0,
        `delete returned ${fundBareDeleted}, parent and subcategory hold ${fundBareHeld} rows`,
      );

      const fundSpent = await pair("fund", "fund spent");
      await splitOn(fundAccount.id, fundSpent.child);
      const fundSpentRefusal = await refusalOf((sp) =>
        sp.execute(dsql`delete from categories where id = ${fundSpent.parent}`),
      );
      const fundSpentHeld = await rowsHeld([fundSpent.parent, fundSpent.child]);
      assert(
        labels[4],
        fundSpentRefusal.includes("23503") && fundSpentHeld === 2,
        `${fundSpentRefusal}; parent and subcategory hold ${fundSpentHeld} of 2 rows`,
      );

      // 387: the key by name and action, and the composite one it stands beside.
      const keys = await asPostgres(() =>
        tx.execute<{
          conname: string;
          confdeltype: string;
          columns: string;
          target_columns: string;
          self_reference: boolean;
          definition: string;
        }>(
          dsql`select c.conname, c.confdeltype::text as confdeltype,
              (select string_agg(a.attname, ',' order by k.ord)
                 from unnest(c.conkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns,
              (select string_agg(a.attname, ',' order by k.ord)
                 from unnest(c.confkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as target_columns,
              (c.confrelid = 'finances.categories'::regclass) as self_reference,
              pg_get_constraintdef(c.oid) as definition
            from pg_constraint c
            where c.conrelid = 'finances.categories'::regclass and c.contype = 'f'
              and c.conname in ('categories_parent_id_categories_id_fk',
                                'categories_parent_id_group_id_categories_id_group_id_fk')`,
        ),
      );
      const single = keys.find((k) => k.conname === "categories_parent_id_categories_id_fk");
      const composite = keys.find((k) => k.conname === "categories_parent_id_group_id_categories_id_group_id_fk");
      assert(
        labels[6],
        single?.confdeltype === "c" &&
          single.columns === "parent_id" &&
          single.target_columns === "id" &&
          single.self_reference &&
          composite?.confdeltype === "c" &&
          composite.columns === "parent_id,group_id" &&
          composite.target_columns === "id,group_id" &&
          composite.self_reference,
        `single = ${single ? `${single.columns} → ${single.definition}` : "absent"}; composite = ${composite?.definition ?? "absent"}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from categories where name like 'rls subcategory cascade%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls subcategory cascade%' = ${probeCount}`,
  );
}

// Assertions 215-217: RF-59 at the moment a group is born. `groups_insert_any` is `WITH CHECK true` and
// `assert_group_keeps_leader` fires only on UPDATE and DELETE, so an insert into `groups` not followed
// by its leader row committed an orphan — proved on the live database as a row nobody can see, since it
// fails its own SELECT policy, and nobody can remove, since `groups` carries no DELETE policy and no
// DELETE grant. The new trigger is deferred, so it is `set constraints ... immediate` that reaches it
// inside a transaction which never commits. Fixtures roll back; each barred statement has its savepoint.
async function checkGroupCommitsWithLeader() {
  console.log("");
  const creator = randomUUID();
  const orphanGroup = randomUUID();
  const properGroup = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "215. a group inserted without its leader row is refused at commit",
    "216. a group inserted with its leader row commits and is visible to its creator",
  ];
  const tailLabel = "217. the rolled-back orphan-group transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      await tx.execute(dsql`insert into auth.users (id) values (${creator})`);
      await tx.execute(dsql`insert into app_users (id) values (${creator})`);
      await enter(tx, creator);

      // 215: the orphan. No RETURNING on the insert — that would apply the SELECT policy the creator
      // does not satisfy yet, and the refusal under test is the trigger's, not a policy's.
      let orphanVisible = "not read";
      let orphanRefusal = "no refusal — the orphan group stood at commit";
      await tx
        .transaction(async (sp) => {
          await sp.execute(
            dsql`insert into groups (id, name, cash_mode)
              values (${orphanGroup}, 'rls orphan group', 'shared')`,
          );
          const [own] = await sp.execute<{ count: string }>(
            dsql`select count(*)::text as count from groups where id = ${orphanGroup}`,
          );
          orphanVisible = own.count;
          await sp.execute(dsql`set constraints "assert_group_has_leader" immediate`);
        })
        .catch((error: unknown) => {
          orphanRefusal = describeRefusal(error);
        });
      assert(
        labels[0],
        orphanRefusal.includes("23514") &&
          orphanRefusal.includes("without a leader") &&
          orphanVisible === "0",
        `${orphanRefusal}; rows its own creator could see = ${orphanVisible}`,
      );

      // 216: the negative control — `createGroup` writes the group and its leader in one transaction,
      // and the deferral is what lets it keep writing them in that order.
      let properOutcome = "the pair never ran";
      let properVisible = "not read";
      await tx
        .transaction(async (sp) => {
          await sp.execute(
            dsql`insert into groups (id, name, cash_mode)
              values (${properGroup}, 'rls proper group', 'shared')`,
          );
          await sp.execute(
            dsql`insert into group_members (group_id, user_id, name, role)
              values (${properGroup}, ${creator}, 'rls proper group leader', 'leader')`,
          );
          await sp.execute(dsql`set constraints "assert_group_has_leader" immediate`);
          const [own] = await sp.execute<{ count: string }>(
            dsql`select count(*)::text as count from groups where id = ${properGroup}`,
          );
          properVisible = own.count;
          properOutcome = "accepted";
        })
        .catch((error: unknown) => {
          properOutcome = describeRefusal(error);
        });
      assert(
        labels[1],
        properOutcome === "accepted" && properVisible === "1",
        `${properOutcome}, rows its creator can see = ${properVisible}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls orphan group%' or name like 'rls proper group%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls orphan group%' or 'rls proper group%' = ${probeCount}`,
  );
}

// Assertions 218-221: RF-82 in the engine. "Paid in full or not at all, oldest first" lived only in a
// TypeScript loop; `assert_installment_line_payment` checked nothing but that the movement touches the
// plan's account, and `paid_transaction_id` is the one column `authenticated` may UPDATE on
// `installment_lines`. One 100-cent movement marked all three 100000-cent lines paid on the live
// database and the derived pending read 0 against an untouched debt. The new trigger is deferred so the
// allocator's multi-row UPDATE is judged whole, which is why `set constraints ... immediate` is what
// reaches it here. Fixtures roll back; each barred statement has its savepoint.
async function checkInstallmentAllocation() {
  console.log("");
  const owner = randomUUID();
  const today = "2026-01-16";
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "218. one 100-cent movement cannot mark three 100000-cent lines paid",
    "219. a line is refused while an older unpaid line of the same account stands",
    "220. the allocator's oldest-first, in-full assignment of two lines to one covering movement commits",
  ];
  const tailLabel = "221. the rolled-back allocation transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${owner})`);
      await tx.execute(dsql`insert into app_users (id) values (${owner})`);
      await enter(tx, owner);

      const [card] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
          values (${owner}, 'rls allocation card', 'liability', -900000, ${today}) returning id`,
      );
      const [cash] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
          values (${owner}, 'rls allocation cash', 'asset', 1000000, ${today}) returning id`,
      );
      const [plan] = await tx.execute<{ id: string }>(
        dsql`insert into installment_plans (account_id, principal_cents, n_installments, frequency, start_date)
          values (${card.id}, 300000, 3, 'monthly', ${today}) returning id`,
      );
      await tx.execute(
        dsql`insert into installment_lines (plan_id, seq, due_date, amount_cents) values
          (${plan.id}, 1, '2026-02-15', 100000),
          (${plan.id}, 2, '2026-03-15', 100000),
          (${plan.id}, 3, '2026-04-15', 100000)`,
      );
      const [coin] = await tx.execute<{ id: string }>(
        dsql`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
          values (${cash.id}, ${card.id}, 100, ${today}) returning id`,
      );
      const [covering] = await tx.execute<{ id: string }>(
        dsql`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
          values (${cash.id}, ${card.id}, 200000, ${today}) returning id`,
      );

      // 218: the whole plan marked paid by a movement of one peso. Both statements pass
      // `assert_installment_line_payment`: the movement does touch the plan's account.
      let sweptRows = -1;
      let sweepRefusal = "no refusal — the sweep stood at commit";
      await tx
        .transaction(async (sp) => {
          const rows = await sp.execute<{ id: string }>(
            dsql`update installment_lines set paid_transaction_id = ${coin.id}
              where plan_id = ${plan.id} returning id`,
          );
          sweptRows = rows.length;
          await sp.execute(dsql`set constraints "assert_installment_allocation" immediate`);
        })
        .catch((error: unknown) => {
          sweepRefusal = describeRefusal(error);
        });
      assert(
        labels[0],
        sweepRefusal.includes("23514") && sweepRefusal.includes("cannot pay lines totalling"),
        `the UPDATE reached ${sweptRows === -1 ? "no" : sweptRows} lines, ${sweepRefusal}`,
      );

      // 219: the order. The movement covers the line twice over; what refuses it is the older line of
      // the same account left unpaid behind it.
      const skipRefusal = await refusalOf(async (sp) => {
        await sp.execute(
          dsql`update installment_lines set paid_transaction_id = ${covering.id}
            where plan_id = ${plan.id} and seq = 2`,
        );
        await sp.execute(dsql`set constraints "assert_installment_allocation" immediate`);
      });
      assert(
        labels[1],
        skipRefusal.includes("23514") && skipRefusal.includes("older unpaid line"),
        skipRefusal,
      );

      // 220: the negative control — the walk `recordDebtPayment` runs, which pays the two oldest lines
      // in full and stops at the third. A trigger that refused this would have removed the feature.
      let fifoOutcome = "the allocation never ran";
      let fifoState = "not read";
      await tx
        .transaction(async (sp) => {
          await sp.execute(
            dsql`update installment_lines set paid_transaction_id = ${covering.id}
              where plan_id = ${plan.id} and seq in (1, 2)`,
          );
          await sp.execute(dsql`set constraints "assert_installment_allocation" immediate`);
          const rows = await sp.execute<{ seq: number; paid: boolean }>(
            dsql`select seq, paid_transaction_id is not null as paid from installment_lines
              where plan_id = ${plan.id} order by seq`,
          );
          fifoState = rows.map((row) => `${row.seq}:${row.paid}`).join(", ");
          fifoOutcome = "accepted";
        })
        .catch((error: unknown) => {
          fifoOutcome = describeRefusal(error);
        });
      assert(
        labels[2],
        fifoOutcome === "accepted" && fifoState === "1:true, 2:true, 3:false",
        `${fifoOutcome}, paid by seq = ${fifoState}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls allocation%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls allocation%' = ${probeCount}`,
  );
}

// Assertions 222-226: the goal's account. `assert_goal_contribution_scope` guards the movement a
// contribution earmarks and never the account the goal names, and nothing else looked: the hole was
// suspected, not proved, so it was opened first — a personal goal naming a group account, and a second
// naming another person's personal account, each landed one row on the live database under RLS. Both
// are executed here against the guard that now stands. Fixtures live in one transaction forced to roll
// back; each barred statement runs in its own savepoint.
async function checkGoalAccountScope() {
  console.log("");
  const leaderUser = randomUUID();
  const strangerUser = randomUUID();
  const groupId = randomUUID();
  const today = "2026-01-01";
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "222. a personal goal naming a group account is refused",
    "223. a personal goal naming another person's account is refused",
    "224. a goal naming its owner's own account, and one naming no account, both land",
    "225. a group goal naming that group's account lands",
  ];
  const tailLabel = "226. the rolled-back goal-scope transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(
        dsql`insert into auth.users (id) values (${leaderUser}), (${strangerUser})`,
      );
      await tx.execute(
        dsql`insert into app_users (id) values (${leaderUser}), (${strangerUser})`,
      );

      // The stranger's own account, written by the stranger: nobody else could have.
      await enter(tx, strangerUser);
      const [strangerAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
          values (${strangerUser}, 'rls goal scope stranger', 'asset', 100000, ${today}) returning id`,
      );

      await tx.execute(dsql`reset role`);
      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls goal scope', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls goal scope leader', 'leader')`,
      );
      const [groupAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (group_id, is_shared, name, kind, initial_balance_cents, initial_balance_on)
          values (${groupId}, true, 'rls goal scope group', 'asset', 100000, ${today}) returning id`,
      );
      const [ownAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
          values (${leaderUser}, 'rls goal scope own', 'asset', 100000, ${today}) returning id`,
      );

      // 222: the group's account is one the caller may write, which is why no policy stopped this.
      const groupRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into savings_goals (owner_user_id, name, target_amount_cents, account_id)
            values (${leaderUser}, 'rls goal scope on group account', 500000, ${groupAccount.id})`,
        ),
      );
      assert(
        labels[0],
        groupRefusal.includes("23514") && groupRefusal.includes("its own scope"),
        groupRefusal,
      );

      // 223: an account the caller cannot read, let alone write, named by a goal that is entirely his.
      const strangerRefusal = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into savings_goals (owner_user_id, name, target_amount_cents, account_id)
            values (${leaderUser}, 'rls goal scope on stranger account', 500000, ${strangerAccount.id})`,
        ),
      );
      assert(
        labels[1],
        strangerRefusal.includes("23514") && strangerRefusal.includes("its own scope"),
        strangerRefusal,
      );

      // 224, 225: the negative controls — the account a goal may name is still nameable, in either
      // scope, and a goal naming none at all is still legal (RF-77).
      const onOwn = await tx.execute<{ id: string }>(
        dsql`insert into savings_goals (owner_user_id, name, target_amount_cents, account_id)
          values (${leaderUser}, 'rls goal scope own goal', 500000, ${ownAccount.id}) returning id`,
      );
      const onNone = await tx.execute<{ id: string }>(
        dsql`insert into savings_goals (owner_user_id, name, target_amount_cents)
          values (${leaderUser}, 'rls goal scope accountless goal', 500000) returning id`,
      );
      assert(
        labels[2],
        onOwn.length === 1 && onNone.length === 1,
        `on its owner's account ${onOwn.length} row, on no account ${onNone.length} row`,
      );

      const onGroup = await tx.execute<{ id: string }>(
        dsql`insert into savings_goals (group_id, name, target_amount_cents, account_id)
          values (${groupId}, 'rls goal scope group goal', 500000, ${groupAccount.id}) returning id`,
      );
      assert(labels[3], onGroup.length === 1, `landed ${onGroup.length} row`);

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from savings_goals where name like 'rls goal scope%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls goal scope%' = ${probeCount}`,
  );
}

// Assertions 227-232: RF-99, the undo of a silenced shape. Every claim here is about
// `silenced_on_arrival`, the column that tells the machine's rejection from a person's:
// who writes it, who can reach a row carrying it, and what a restore is allowed to move.
async function checkIngestShapeRestore() {
  console.log("");
  const owner = randomUUID();
  const other = randomUUID();
  const today = "2026-01-01";
  const silencedHash = createHash("sha256").update(randomUUID()).digest("hex");
  const probeHash = createHash("sha256").update(randomUUID()).digest("hex");
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "227. the shape memory settles the arrival: silenced under a rejected shape, pending under none",
    "228. neither review path reaches a silenced delivery",
    "229. a restore keeping the flag is refused and the same one clearing it lands",
    "230. a second user's delete filters to nothing and their restore returns nothing",
    "231. the owner's restore drops one shape and returns only what the silence discarded",
    "232. the same shape arrives pending once the silence is undone",
  ];

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      await tx.execute(dsql`insert into auth.users (id) values (${owner}), (${other})`);
      await tx.execute(dsql`insert into app_users (id) values (${owner}), (${other})`);
      await enter(tx, owner);

      // Every statement below runs in its own savepoint, the permitted ones included: a
      // refusal reports its sqlstate AND its message, because 42501 covers both a missing
      // grant and a policy, and 23514 names which check fired only in the message.
      const attempt = async <T extends Record<string, unknown>>(
        run: (sp: OrmTx) => Promise<T[]>,
      ): Promise<{ rows: T[]; refusal: string }> => {
        let outcome = { rows: [] as T[], refusal: "no refusal" };
        await tx
          .transaction(async (sp) => {
            outcome = { rows: [...(await run(sp))], refusal: "no refusal" };
          })
          .catch((error: unknown) => {
            outcome = { rows: [], refusal: describeRefusal(error) };
          });
        return outcome;
      };

      // `restoreShape`'s one statement, verbatim: the shape and the deliveries it silenced
      // move together or not at all, and the counts are what the caller reads.
      const restore = (on: OrmTx, shapeId: string) =>
        on.execute<{ shapes: number; deliveries: number }>(dsql`
          with dropped as (
            delete from ingest_shapes
            where id = ${shapeId} and decision = 'rejected'
            returning shape_hash
          ),
          restored as (
            update ingest_deliveries d
               set status = 'pending', resolved_at = null, silenced_on_arrival = false
              from dropped
             where d.shape_hash = dropped.shape_hash
               and d.status = 'rejected'
               and d.silenced_on_arrival
            returning d.id
          )
          select (select count(*)::int from dropped)  as shapes,
                 (select count(*)::int from restored) as deliveries`);

      // 227: the trigger's two branches on one hash. The human-rejected delivery is
      // inserted BEFORE the shape exists, so it arrives pending — that is the negative
      // control, and it is the row the restore below must leave alone.
      const [human] = await tx.execute<{
        id: string;
        status: string;
        silenced_on_arrival: boolean;
      }>(dsql`insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-restore-human', 'fixture', ${silencedHash})
        returning id, status, silenced_on_arrival`);
      await tx.execute(dsql`update ingest_deliveries
        set status = 'rejected', resolved_at = now()
        where id = ${human.id} and status = 'pending'`);

      await tx.execute(dsql`insert into ingest_shapes (shape_hash, decision, sample_text)
        values (${silencedHash}, 'rejected', 'fixture'), (${probeHash}, 'rejected', 'fixture')`);
      const [shape] = await tx.execute<{ id: string }>(
        dsql`select id from ingest_shapes where shape_hash = ${silencedHash}`,
      );

      const silenced = await tx.execute<{
        id: string;
        status: string;
        silenced_on_arrival: boolean;
      }>(dsql`insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-restore-silenced-a', 'fixture', ${silencedHash}),
               ('rls-restore-silenced-b', 'fixture', ${silencedHash})
        returning id, status, silenced_on_arrival`);

      assert(
        labels[0],
        silenced.length === 2 &&
          silenced.every(
            (row) => row.status === "rejected" && row.silenced_on_arrival === true,
          ) &&
          human.status === "pending" &&
          human.silenced_on_arrival === false,
        `shape ${silencedHash.slice(0, 12)} under a rejected memory stored ${silenced.map((row) => `${row.status}/${row.silenced_on_arrival}`).join(" and ")}, the same shape under no memory stored ${human.status}/${human.silenced_on_arrival}`,
      );

      // 228: both review paths carry `and status = 'pending'`, so a silenced row is out of
      // a person's reach without any policy having to say so. The account and the movement
      // exist only to make the accept path's statement the real one.
      const [account] = await tx.execute<{ id: string }>(
        dsql`insert into accounts
          (owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
          values (${owner}, 'RLS restore account', 'asset', 'cash', 100000, ${today})
          returning id`,
      );
      const [movement] = await tx.execute<{ id: string }>(
        dsql`insert into transactions (from_account_id, amount_cents, occurred_at)
          values (${account.id}, 5000, ${today}) returning id`,
      );
      const target = silenced[0].id;

      const guard = await attempt((sp) =>
        sp.execute<{ id: string }>(dsql`select id from ingest_deliveries
          where id = ${target} and status = 'pending' for update`),
      );
      const rejectPath = await attempt((sp) =>
        sp.execute<{ id: string }>(dsql`update ingest_deliveries
          set status = 'rejected', resolved_at = now()
          where id = ${target} and status = 'pending' returning id`),
      );
      const acceptPath = await attempt((sp) =>
        sp.execute<{ id: string }>(dsql`update ingest_deliveries
          set status = 'accepted', resolved_at = now(), transaction_id = ${movement.id}
          where id = ${target} and status = 'pending' returning id`),
      );

      assert(
        labels[1],
        guard.rows.length === 0 &&
          rejectPath.rows.length === 0 &&
          acceptPath.rows.length === 0 &&
          guard.refusal === "no refusal" &&
          rejectPath.refusal === "no refusal" &&
          acceptPath.refusal === "no refusal",
        `the accept guard locked ${guard.rows.length} rows (${guard.refusal}), the reject update changed ${rejectPath.rows.length} (${rejectPath.refusal}), the accept update changed ${acceptPath.rows.length} (${acceptPath.refusal})`,
      );

      // 229: on a shape of its own, so the counts the restore returns below stay untouched.
      // Turning a silenced row pending while it keeps the flag is the database's refusal,
      // not the writer's discipline — a restored delivery is indistinguishable from one
      // that never arrived silenced.
      const [probe] = await tx.execute<{ id: string }>(
        dsql`insert into ingest_deliveries (external_ref, raw_text, shape_hash)
          values ('rls-restore-probe', 'fixture', ${probeHash}) returning id`,
      );
      const keptFlag = await attempt((sp) =>
        sp.execute<{ id: string }>(dsql`update ingest_deliveries
          set status = 'pending', resolved_at = null
          where id = ${probe.id} returning id`),
      );
      const clearedFlag = await attempt((sp) =>
        sp.execute<{ status: string; silenced_on_arrival: boolean }>(dsql`
          update ingest_deliveries
          set status = 'pending', resolved_at = null, silenced_on_arrival = false
          where id = ${probe.id} returning status, silenced_on_arrival`),
      );

      assert(
        labels[2],
        keptFlag.refusal.includes("23514") &&
          keptFlag.refusal.includes("ingest_deliveries_silenced_only_when_rejected") &&
          clearedFlag.rows.length === 1 &&
          clearedFlag.rows[0].status === "pending" &&
          clearedFlag.rows[0].silenced_on_arrival === false,
        `keeping the flag ${keptFlag.refusal}, clearing it stored ${clearedFlag.rows[0]?.status ?? "nothing"}/${clearedFlag.rows[0]?.silenced_on_arrival ?? "nothing"}`,
      );

      // 230: the delete policy filters, it does not refuse — a second user's statement is
      // well-formed, touches nothing and raises nothing. Run before the owner's restore,
      // while the shape and its silenced deliveries are still there to be taken.
      await enter(tx, other);
      const otherDelete = await attempt((sp) =>
        sp.execute<{ id: string }>(dsql`delete from ingest_shapes
          where id = ${shape.id} and decision = 'rejected' returning id`),
      );
      const otherRestore = await attempt((sp) => restore(sp, shape.id));

      assert(
        labels[3],
        otherDelete.rows.length === 0 &&
          otherDelete.refusal === "no refusal" &&
          otherRestore.refusal === "no refusal" &&
          otherRestore.rows[0]?.shapes === 0 &&
          otherRestore.rows[0]?.deliveries === 0,
        `their delete removed ${otherDelete.rows.length} shapes (${otherDelete.refusal}), their restore returned ${otherRestore.rows[0]?.shapes ?? "nothing"} shapes and ${otherRestore.rows[0]?.deliveries ?? "nothing"} deliveries (${otherRestore.refusal})`,
      );

      // 231: the owner's own restore. Two silenced deliveries come back, the person's
      // rejection of the same shape does not, and the probe shape is proof the delete
      // took one row rather than every rejected memory the owner holds.
      await enter(tx, owner);
      const owned = await attempt((sp) => restore(sp, shape.id));
      const after = await tx.execute<{
        id: string;
        status: string;
        silenced_on_arrival: boolean;
        unresolved: boolean;
      }>(dsql`select id, status, silenced_on_arrival, resolved_at is null as unresolved
        from ingest_deliveries where shape_hash = ${silencedHash}`);
      const [shapesLeft] = await tx.execute<{ silenced: number; probe: number }>(dsql`
        select
          (select count(*)::int from ingest_shapes where shape_hash = ${silencedHash}) as silenced,
          (select count(*)::int from ingest_shapes where shape_hash = ${probeHash}) as probe`);

      const restoredRows = after.filter((row) => silenced.some((s) => s.id === row.id));
      const humanRow = after.find((row) => row.id === human.id);

      assert(
        labels[4],
        owned.rows[0]?.shapes === 1 &&
          owned.rows[0]?.deliveries === 2 &&
          restoredRows.length === 2 &&
          restoredRows.every(
            (row) =>
              row.status === "pending" &&
              row.silenced_on_arrival === false &&
              row.unresolved,
          ) &&
          humanRow?.status === "rejected" &&
          humanRow.silenced_on_arrival === false &&
          shapesLeft.silenced === 0 &&
          shapesLeft.probe === 1,
        `it dropped ${owned.rows[0]?.shapes ?? "nothing"} shape and returned ${owned.rows[0]?.deliveries ?? "nothing"} deliveries, now ${restoredRows.map((row) => row.status).join(" and ")}; the person's rejection stayed ${humanRow?.status}/${humanRow?.silenced_on_arrival}; ${shapesLeft.silenced} silenced memory left, ${shapesLeft.probe} other memory untouched (${owned.refusal})`,
      );

      // 232: RF-99's forward half. Nothing was written to say the shape is welcome again;
      // the absent memory is what `private.set_ingest_delivery_state` reads as never seen.
      const [returning] = await tx.execute<{
        status: string;
        silenced_on_arrival: boolean;
      }>(dsql`insert into ingest_deliveries (external_ref, raw_text, shape_hash)
        values ('rls-restore-after', 'fixture', ${silencedHash})
        returning status, silenced_on_arrival`);

      assert(
        labels[5],
        returning.status === "pending" && returning.silenced_on_arrival === false,
        `shape ${silencedHash.slice(0, 12)} now arrives ${returning.status}/${returning.silenced_on_arrival}, where before the restore it arrived rejected/true`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });
}

// Assertions 233-235: RF-19 read back through the functions that ship, not through a copy of their
// SQL. Assertions 38-39 and 124-125 prove the same exclusion against the replicas above, which would
// stay green the day `getSixMonthFlow` lost its `filter`; these call it, and `listBudgetsWithStatus`,
// and read the number they hand a screen. The fixtures are therefore COMMITTED — each function opens
// its own transaction over the app pool and can see nothing this file has not committed — and dropped
// in the `finally` below. RLS still decides every row: `withUserDb` settles the same claims and the
// same `authenticated` role `enterUserContext` sets by hand, so the reads meet the policies here too.
async function checkReportFunctionsExcludeTransfers() {
  console.log("");
  const reader = randomUUID();
  const email = `rls-report-${reader}@example.invalid`;

  const labels = [
    "233. getSixMonthFlow reads this month at the income and the expense; the transfer joins neither",
    "234. listBudgetsWithStatus spends the expense split alone; the transfer over its account adds nothing",
  ];
  const tailLabel = "235. the committed report fixtures are gone";

  const INCOME_CENTS = 10000;
  const EXPENSE_CENTS = 6000;
  const TRANSFER_CENTS = 5000;
  const LIMIT_CENTS = 100000;

  const budgetId = randomUUID();
  const claims = JSON.stringify({ sub: reader, role: "authenticated", aud: "authenticated" });
  let auditPurged = "0";

  // The Supabase stub reads these, and it throws rather than query as nobody.
  process.env.HARNESS_USER_ID = reader;
  process.env.HARNESS_USER_EMAIL = email;

  try {
    // One statement, not two: a crash between the auth row and the registry row
    // can never happen — there is no gap between them for it to land in. It needs
    // no transaction of its own; the CTE it runs on is already atomic.
    await registerEphemeralIdentity(sql, { id: reader, email });

    await sql.begin(async (tx) => {
      // Claims without the role switch: the stamping triggers read `auth.uid()` while the owner's
      // privileges do the writing, so a fixture never has to satisfy a column grant of its own.
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;

      const today = tx`(now() at time zone 'America/Bogota')::date`;
      const [{ id: fromAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${reader}, 'rls report bank', 'asset', 500000, ${today}) returning id`;
      const [{ id: toAccount }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${reader}, 'rls report savings', 'asset', 0, ${today}) returning id`;
      const [{ id: expenseCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${reader}, 'rls report groceries', 'expense') returning id`;
      const [{ id: incomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${reader}, 'rls report salary', 'income') returning id`;

      const [{ id: incomeTxn }] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at)
        values (${fromAccount}, ${INCOME_CENTS}, ${today}) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${incomeTxn}, ${incomeCat}, ${INCOME_CENTS})`;

      const [{ id: expenseTxn }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${fromAccount}, ${EXPENSE_CENTS}, ${today}) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${expenseTxn}, ${expenseCat}, ${EXPENSE_CENTS})`;

      // The transfer sits in both windows and leaves the very account the budget names.
      await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${fromAccount}, ${toAccount}, ${TRANSFER_CENTS}, ${today})`;

      await tx`insert into budgets (
          id, owner_user_id, category_id, account_id, period, limit_cents, threshold_pct, name)
        values (
          ${budgetId}, ${reader}, ${expenseCat}, ${fromAccount}, 'monthly',
          ${LIMIT_CENTS}, 80, 'rls report budget')`;
    });

    // 233 (RF-19, RF-35): the six buckets the trend renders, the last of them this month. A transfer
    // summed as either total would put 15000 of income or 11000 of expense in it.
    const flow = await getSixMonthFlow();
    const thisMonth = flow[flow.length - 1];
    assert(
      labels[0],
      flow.length === 6 &&
        thisMonth.monthStart.slice(0, 7) === todayInBogota().slice(0, 7) &&
        thisMonth.incomeCents === INCOME_CENTS &&
        thisMonth.expenseCents === EXPENSE_CENTS,
      `${flow.length} months, ${thisMonth?.monthStart} reads income = ${thisMonth?.incomeCents}, expense = ${thisMonth?.expenseCents} (expected ${INCOME_CENTS} and ${EXPENSE_CENTS}, the ${TRANSFER_CENTS} transfer in neither)`,
    );

    // 234 (RF-19, RF-72): spent is the one expense split. The transfer leaves the budget's account
    // inside its window and carries no split of its own — assertion 32 is why it can carry none.
    const budgets = await listBudgetsWithStatus();
    const budget = budgets.find((row) => row.id === budgetId);
    assert(
      labels[1],
      budget?.spentCents === EXPENSE_CENTS &&
        budget.remainingCents === LIMIT_CENTS - EXPENSE_CENTS,
      `spent = ${budget?.spentCents}, remaining = ${budget?.remainingCents} (expected ${EXPENSE_CENTS} and ${LIMIT_CENTS - EXPENSE_CENTS}, the ${TRANSFER_CENTS} transfer in neither)`,
    );
  } finally {
    delete process.env.HARNESS_USER_ID;
    delete process.env.HARNESS_USER_EMAIL;

    // Settled once, at session scope rather than transaction-local: the six deletes
    // below are separate statements outside any transaction, and each reads this
    // same claim, so their audit rows name the reader as actor instead of nobody.
    await sql`select set_config('request.jwt.claims', ${claims}, false)`;

    // Child before parent, and the splits ride the movements' cascade. No rollback undoes any of
    // this: the reads above could only see it because it was committed.
    await sql`delete from budgets where owner_user_id = ${reader}`;
    await sql`delete from transactions where owner_user_id = ${reader}`;
    await sql`delete from categories where owner_user_id = ${reader}`;
    await sql`delete from accounts where owner_user_id = ${reader}`;
    await sql`delete from app_users where id = ${reader}`;
    await sql`delete from auth.users where id = ${reader}`;

    // The trail those six deletes stamped: bounded to the reader's two columns,
    // same shape as `purgeAuditTrail`, so this section's commit leaves nothing for
    // RNF-14's purge to find later.
    const [{ count }] = await sql<{ count: string }[]>`
      with purged as (
        delete from audit_log where actor_user_id = ${reader} or owner_user_id = ${reader}
        returning 1
      )
      select count(*)::text as count from purged`;
    auditPurged = count;
    await sql`select set_config('request.jwt.claims', '', false)`;
  }

  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls report%'`;
  const [{ count: userCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from app_users where id = ${reader}`;
  assert(
    tailLabel,
    probeCount === "0" && userCount === "0",
    `rows named 'rls report%' = ${probeCount}, the reader's own row = ${userCount}, its audit trail = ${auditPurged} purged`,
  );
}

// Assertions 236-240: the group's settings, written the way `updateGroupSettings` writes them — one
// statement carrying both `name` and `cash_mode`, the two of the group's three updatable columns the
// form owns. Assertion 198 proved the rename alone; the mode rode in on the same grant and was
// never issued here. The two CHECKs are what stands between the form's Zod schema and a stored
// value nothing reads back. Fixtures live in one transaction forced to roll back.
async function checkGroupSettingsWrite() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "236. the leader's one statement stores the new name and the new cash mode together",
    "237. a plain member's identical statement touches no row and leaves both stored values standing",
    "238. a cash mode outside the two the model admits is refused",
    "239. a name of 81 characters is refused",
  ];
  const tailLabel = "240. the rolled-back group settings transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      // Read as the owner: the assertion is about what the row STORES, not about what a policy
      // would show the caller who just tried to write it.
      const stored = async () => {
        await tx.execute(dsql`reset role`);
        const [row] = await tx.execute<{ name: string; cash_mode: string }>(
          dsql`select name, cash_mode from groups where id = ${groupId}`,
        );
        return row;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${leaderUser}), (${memberUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${leaderUser}), (${memberUser})`);

      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls group settings', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls group settings leader', 'leader')`,
      );
      // A member's row carries a login, which no policy hands out, so it is seeded as `postgres`.
      await tx.execute(dsql`reset role`);
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${memberUser}, 'rls group settings member', 'member')`,
      );

      await enter(tx, leaderUser);
      const written = await tx.execute<{ name: string; cash_mode: string }>(
        dsql`update groups set name = 'rls group settings taken', cash_mode = 'per_member'
          where id = ${groupId} returning name, cash_mode`,
      );
      assert(
        labels[0],
        written.length === 1 &&
          written[0].name === "rls group settings taken" &&
          written[0].cash_mode === "per_member",
        `${written.length} row now named '${written[0]?.name}' at cash mode ${written[0]?.cash_mode}`,
      );

      const modeRefusal = await refusalOf((sp) =>
        sp.execute(dsql`update groups set cash_mode = 'mixto' where id = ${groupId}`),
      );
      const nameRefusal = await refusalOf((sp) =>
        sp.execute(dsql`update groups set name = repeat('x', 81) where id = ${groupId}`),
      );
      const afterRefusals = await stored();
      assert(
        labels[2],
        modeRefusal.includes("23514") &&
          modeRefusal.includes("groups_cash_mode_valid") &&
          afterRefusals.cash_mode === "per_member",
        `${modeRefusal}, cash mode = ${afterRefusals.cash_mode}`,
      );
      assert(
        labels[3],
        nameRefusal.includes("23514") &&
          nameRefusal.includes("groups_name_length") &&
          afterRefusals.name === "rls group settings taken",
        `${nameRefusal}, name = '${afterRefusals.name}'`,
      );

      // The member holds the same two-column grant; `groups_update_leader`'s USING is the whole
      // difference between her statement and the leader's.
      await enter(tx, memberUser);
      let memberRows = -1;
      const memberRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`update groups set name = 'rls group settings seized', cash_mode = 'shared'
            where id = ${groupId} returning id`,
        );
        memberRows = rows.length;
      });
      const afterMember = await stored();
      assert(
        labels[1],
        (memberRows === 0 || memberRefusal.includes("42501")) &&
          afterMember.name === "rls group settings taken" &&
          afterMember.cash_mode === "per_member",
        `rows = ${memberRows === -1 ? "none issued" : memberRows}, ${memberRefusal}, name = '${afterMember.name}', cash mode = ${afterMember.cash_mode}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls group settings%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls group settings%' = ${probeCount}`,
  );
}

// Assertions 241-249: archiving (RF-120). Neither `budgets_update_personal` nor
// `savings_goals_update_personal` reads `archived_at`, so putting a record away and taking it back
// out are the same policy decision, and the row stays readable across both — which is what keeps an
// archived record's figures deriving. The last pair is the hole this section was opened for: the
// Aportar button went away from an archived goal one commit earlier, and until migration 0022 the
// database still took the aporte. Fixtures live in one transaction forced to roll back; each barred
// statement runs in its own savepoint.
async function checkArchivePolicies() {
  console.log("");
  const ownerUser = randomUUID();
  const strangerUser = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "241. a budget's owner archives it and still reads the row",
    "242. the owner clears the flag and the budget is live again",
    "243. a second user's archive of that budget touches no row and leaves the flag standing",
    "244. a goal's owner archives it and still reads the row",
    "245. the owner clears the flag and the goal is live again",
    "246. a second user's archive of that goal touches no row and leaves the flag standing",
    "247. an aporte to an archived goal is refused",
    "248. the same aporte lands once the goal is restored",
  ];
  const tailLabel = "249. the rolled-back archive transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${ownerUser}), (${strangerUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${ownerUser}), (${strangerUser})`);

      // Neither user belongs to a group, so `owner_group_id` resolves to null and only ownership
      // is left to decide the stranger's statements below.
      await enter(tx, ownerUser);
      // `id` sits outside every INSERT grant here, so each row is read back rather than named.
      const [category] = await tx.execute<{ id: string }>(
        dsql`insert into categories (owner_user_id, name, kind, color)
          values (${ownerUser}, 'rls archive category', 'expense', '#4C8C4A') returning id`,
      );
      const [budget] = await tx.execute<{ id: string }>(
        dsql`insert into budgets (owner_user_id, category_id, period, limit_cents, threshold_pct, name)
          values (${ownerUser}, ${category.id}, 'monthly', 40000000, 80, 'rls archive budget') returning id`,
      );
      const [goal] = await tx.execute<{ id: string }>(
        dsql`insert into savings_goals (owner_user_id, name, target_amount_cents)
          values (${ownerUser}, 'rls archive goal', 200000000) returning id`,
      );

      const budgetArchived = await tx.execute<{ archived_at: string | null }>(
        dsql`update budgets set archived_at = now() where id = ${budget.id} returning archived_at`,
      );
      // Read back under the same session: an archived budget that the select policy dropped would
      // take its spent and remaining off the screen instead of onto the archived side.
      const budgetSeen = await tx.execute<{ archived_at: string | null }>(
        dsql`select archived_at from budgets where id = ${budget.id}`,
      );
      assert(
        labels[0],
        budgetArchived.length === 1 &&
          budgetArchived[0].archived_at !== null &&
          budgetSeen.length === 1 &&
          budgetSeen[0].archived_at !== null,
        `${budgetArchived.length} row archived, the owner still reads ${budgetSeen.length} row with archived_at = ${budgetSeen[0]?.archived_at}`,
      );

      const budgetRestored = await tx.execute<{ archived_at: string | null }>(
        dsql`update budgets set archived_at = null where id = ${budget.id} returning archived_at`,
      );
      assert(
        labels[1],
        budgetRestored.length === 1 && budgetRestored[0].archived_at === null,
        `${budgetRestored.length} row restored, archived_at = ${budgetRestored[0]?.archived_at}`,
      );

      await enter(tx, strangerUser);
      let strangerBudgetRows = -1;
      const strangerBudgetRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`update budgets set archived_at = now() where id = ${budget.id} returning id`,
        );
        strangerBudgetRows = rows.length;
      });
      await tx.execute(dsql`reset role`);
      const [budgetStored] = await tx.execute<{ archived_at: string | null }>(
        dsql`select archived_at from budgets where id = ${budget.id}`,
      );
      assert(
        labels[2],
        (strangerBudgetRows === 0 || strangerBudgetRefusal.includes("42501")) &&
          budgetStored.archived_at === null,
        `rows = ${strangerBudgetRows === -1 ? "none issued" : strangerBudgetRows}, ${strangerBudgetRefusal}, archived_at = ${budgetStored.archived_at}`,
      );

      await enter(tx, ownerUser);
      const goalArchived = await tx.execute<{ archived_at: string | null }>(
        dsql`update savings_goals set archived_at = now() where id = ${goal.id} returning archived_at`,
      );
      const goalSeen = await tx.execute<{ archived_at: string | null }>(
        dsql`select archived_at from savings_goals where id = ${goal.id}`,
      );
      assert(
        labels[3],
        goalArchived.length === 1 &&
          goalArchived[0].archived_at !== null &&
          goalSeen.length === 1 &&
          goalSeen[0].archived_at !== null,
        `${goalArchived.length} row archived, the owner still reads ${goalSeen.length} row with archived_at = ${goalSeen[0]?.archived_at}`,
      );

      const goalRestored = await tx.execute<{ archived_at: string | null }>(
        dsql`update savings_goals set archived_at = null where id = ${goal.id} returning archived_at`,
      );
      assert(
        labels[4],
        goalRestored.length === 1 && goalRestored[0].archived_at === null,
        `${goalRestored.length} row restored, archived_at = ${goalRestored[0]?.archived_at}`,
      );

      await enter(tx, strangerUser);
      let strangerGoalRows = -1;
      const strangerGoalRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`update savings_goals set archived_at = now() where id = ${goal.id} returning id`,
        );
        strangerGoalRows = rows.length;
      });
      await tx.execute(dsql`reset role`);
      const [goalStored] = await tx.execute<{ archived_at: string | null }>(
        dsql`select archived_at from savings_goals where id = ${goal.id}`,
      );
      assert(
        labels[5],
        (strangerGoalRows === 0 || strangerGoalRefusal.includes("42501")) &&
          goalStored.archived_at === null,
        `rows = ${strangerGoalRows === -1 ? "none issued" : strangerGoalRows}, ${strangerGoalRefusal}, archived_at = ${goalStored.archived_at}`,
      );

      // The owner's own aporte, on the owner's own goal: nothing but the flag stands in its way.
      await enter(tx, ownerUser);
      await tx.execute(
        dsql`update savings_goals set archived_at = now() where id = ${goal.id}`,
      );
      const aporteRefusal = await refusalOf((sp) =>
        sp.execute(dsql`insert into goal_contributions (goal_id, transaction_id, amount_cents)
          values (${goal.id}, null, 5000000)`),
      );
      const [{ count: refusedCount }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from goal_contributions where goal_id = ${goal.id}`,
      );
      assert(
        labels[6],
        aporteRefusal.includes("42501") && refusedCount === "0",
        `${aporteRefusal}, aportes on the goal = ${refusedCount}`,
      );

      await tx.execute(dsql`update savings_goals set archived_at = null where id = ${goal.id}`);
      const landed = await tx.execute<{ amount_cents: string }>(
        dsql`insert into goal_contributions (goal_id, transaction_id, amount_cents)
          values (${goal.id}, null, 5000000) returning amount_cents`,
      );
      // `goal_progress` is what the screen reads, so the restored aporte is asserted through it.
      const [{ saved_cents: savedCents }] = await tx.execute<{ saved_cents: string }>(
        dsql`select saved_cents from goal_progress where goal_id = ${goal.id}`,
      );
      assert(
        labels[7],
        landed.length === 1 && landed[0].amount_cents === "5000000" && savedCents === "5000000",
        `${landed.length} aporte of ${landed[0]?.amount_cents} cents, goal_progress reads ${savedCents}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select
      (select count(*) from budgets where name like 'rls archive%')
      + (select count(*) from savings_goals where name like 'rls archive%')
      + (select count(*) from categories where name like 'rls archive%') as count`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls archive%' = ${probeCount}`,
  );
}

// Assertions 250-251: an aporte carried no date of its own until 0023 — a virtual one earmarks no
// movement, so the list RF-119 puts on the screen had nothing to date it by. The default stamps one
// that names no day; since 0075 a restored backup names the day it had (RF-142), so `created_at` sits
// inside the INSERT grant and the day written is the day kept. Fixtures live in one transaction
// forced to roll back.
async function checkContributionStamp() {
  console.log("");
  const ownerUser = randomUUID();
  const forgedAt = "2000-01-01T00:00:00Z";
  const forcedRollback = Symbol("forced rollback");

  const label = "250. goal_contributions stamps an aporte that names no day and keeps the day a restore names";
  const tailLabel = "251. the rolled-back aporte-date transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${ownerUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${ownerUser})`);

      await enter(tx, ownerUser);
      const [goal] = await tx.execute<{ id: string }>(
        dsql`insert into savings_goals (owner_user_id, name, target_amount_cents)
          values (${ownerUser}, 'rls aporte date goal', 200000000) returning id`,
      );

      const restored = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into goal_contributions (goal_id, amount_cents, created_at)
            values (${goal.id}, 5000000, ${forgedAt}::timestamptz)`,
        ),
      );
      const [{ kept }] = await tx.execute<{ kept: string }>(
        dsql`select count(*)::text as kept from goal_contributions where goal_id = ${goal.id} and created_at = ${forgedAt}::timestamptz`,
      );
      // A virtual aporte, the one that has no movement to borrow a date from.
      const [landed] = await tx.execute<{ forged: boolean; stamped: boolean }>(
        dsql`insert into goal_contributions (goal_id, transaction_id, amount_cents)
          values (${goal.id}, null, 5000000)
          returning created_at = ${forgedAt}::timestamptz as forged, created_at is not null as stamped`,
      );
      assert(
        label,
        restored === "no refusal — the statement was accepted" && kept === "1" && landed.forged === false && landed.stamped,
        `restore: ${restored}, rows on the named day ${kept}; the unnamed row carries that day = ${landed?.forged}, stamped = ${landed?.stamped}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from savings_goals where name like 'rls aporte date%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls aporte date%' = ${probeCount}`,
  );
}

// Assertions 252-254: the third clause of RF-57 — the leader manages the group's categories.
// Assertion 25 puts a plain member's rename to the test and stops there, so `categories_insert_group`
// and `categories_delete_group` had their `private.is_group_leader` gate asserted from the migration
// and never fired. Each barred statement runs as the member and then as the leader, so a policy that
// admitted everyone would fail here rather than pass twice. Fixtures roll back.
async function checkGroupCategoryLeaderOnly() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "252. a plain member cannot mint a group category, and the leader can",
    "253. a plain member's delete of a group category touches nothing, and the leader's removes it",
  ];
  const tailLabel = "254. the rolled-back group category transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      await tx.execute(dsql`insert into auth.users (id) values (${leaderUser}), (${memberUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${leaderUser}), (${memberUser})`);

      // The group's id is supplied client-side: an unclaimed group fails its own SELECT policy.
      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls group category', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls group category leader', 'leader')`,
      );
      // No policy lets one member hand another their login, so the second member is seeded as `postgres`.
      await tx.execute(dsql`reset role`);
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${memberUser}, 'rls group category member', 'member')`,
      );

      await enter(tx, memberUser);
      const memberInsert = await refusalOf((sp) =>
        sp.execute(
          dsql`insert into categories (group_id, name, kind)
            values (${groupId}, 'rls group category forged', 'expense')`,
        ),
      );
      await enter(tx, leaderUser);
      const leaderInsert = await tx.execute<{ id: string }>(
        dsql`insert into categories (group_id, name, kind)
          values (${groupId}, 'rls group category', 'expense') returning id`,
      );
      assert(
        labels[0],
        memberInsert.includes("42501") && leaderInsert.length === 1,
        `${memberInsert}; the leader's insert landed ${leaderInsert.length} row`,
      );

      // The delete policy filters the row out rather than raising, so the member's command reports
      // the row it never saw: zero.
      await enter(tx, memberUser);
      const memberDelete = await tx.execute<{ id: string }>(
        dsql`delete from categories where id = ${leaderInsert[0].id} returning id`,
      );
      await enter(tx, leaderUser);
      const leaderDelete = await tx.execute<{ id: string }>(
        dsql`delete from categories where id = ${leaderInsert[0].id} returning id`,
      );
      assert(
        labels[1],
        memberDelete.length === 0 && leaderDelete.length === 1,
        `member rows = ${memberDelete.length}, leader rows = ${leaderDelete.length}`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from groups where name like 'rls group category%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls group category%' = ${probeCount}`,
  );
}

// Assertions 255-264: RF-59 and RF-11. `private.transfer_group_leadership` and
// `private.assert_member_without_history` landed with 0025 and 0026 and nothing standing named
// either, so both could be dropped and the suite would stay green. Every refusal here is an
// executed statement's sqlstate. The wide net decision 3 fixed is put to three members carrying one
// limb each — an account they own, a movement they recorded, a movement they own — so a limb taken
// out of the guard turns exactly one assertion red instead of hiding behind the other two. The
// third limb has no path through the product today (a personal movement takes its owner from
// `auth.uid()`, which is also its `created_by`), so its row is seeded with the claims cleared.
// Fixtures live in one transaction forced to roll back; each barred statement sits in a savepoint.
async function checkLeadershipTransfer() {
  console.log("");
  const leaderUser = randomUUID();
  const targetUser = randomUUID();
  const accountUser = randomUUID();
  const creatorUser = randomUUID();
  const ownerUser = randomUUID();
  const otherLeaderUser = randomUUID();
  const groupId = randomUUID();
  const otherGroupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "255. the leader transfers the role and the group holds exactly one leader, the former target",
    "256. the outgoing leader, now a plain member, cannot transfer the role",
    "257. a transfer aimed at a member with no login is refused",
    "258. a transfer aimed at a member of another group is refused",
    "259. authenticated holds no UPDATE on group_members.role, and self-promotion is refused",
    "260. each limb of the history net refuses the delete on its own",
    "261. a member who never signed in is still removed",
    "262. archiving a member touches nothing but their own row",
    "263. the transfer left an audit row for each side, naming the outgoing leader",
  ];
  const tailLabel = "264. the rolled-back leadership transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      const transferRefusal = (member: string) =>
        refusalOf((sp) => sp.execute(dsql`select private.transfer_group_leadership(${member})`));

      await tx.execute(dsql`insert into auth.users (id) values
        (${leaderUser}), (${targetUser}), (${accountUser}), (${creatorUser}), (${ownerUser}), (${otherLeaderUser})`);
      await tx.execute(dsql`insert into app_users (id) values
        (${leaderUser}), (${targetUser}), (${accountUser}), (${creatorUser}), (${ownerUser}), (${otherLeaderUser})`);

      // The group's id is supplied client-side: an unclaimed group fails its own SELECT policy.
      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls leader transfer', 'shared')`,
      );
      const [leaderRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls leader transfer leader', 'leader') returning id`,
      );
      // Two shared accounts, so the movement the creator books stays inside the group scope and
      // leaves him owning no account of his own.
      const [fundFrom] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
          values (${groupId}, true, 'rls leader transfer fund', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );
      const [fundTo] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
          values (${groupId}, true, 'rls leader transfer reserve', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );

      // No policy lets one member hand another their login, so every claimed row is seeded as `postgres`.
      await tx.execute(dsql`reset role`);
      const [targetRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${targetUser}, 'rls leader transfer target', 'member') returning id`,
      );
      const [accountRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${accountUser}, 'rls leader transfer account holder', 'member') returning id`,
      );
      const [creatorRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${creatorUser}, 'rls leader transfer recorder', 'member') returning id`,
      );
      const [ownerRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${ownerUser}, 'rls leader transfer movement owner', 'member') returning id`,
      );
      const [ghostRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, name, role)
          values (${groupId}, 'rls leader transfer ghost', 'member') returning id`,
      );
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${otherGroupId}, 'rls leader transfer other', 'shared')`,
      );
      const [otherLeaderRow] = await tx.execute<{ id: string }>(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${otherGroupId}, ${otherLeaderUser}, 'rls leader transfer other leader', 'leader') returning id`,
      );

      // Limb one: an account and nothing else.
      await enter(tx, accountUser);
      const [holderFrom] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_on)
          values (${accountUser}, 'rls leader transfer holder cash', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );
      const [holderTo] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_on)
          values (${accountUser}, 'rls leader transfer holder savings', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );

      // Limb two: a group movement, so `set_transaction_scope` leaves `owner_user_id` null and only
      // `created_by` names the recorder. A transfer carries no split, so nothing else is needed.
      await enter(tx, creatorUser);
      await tx.execute(
        dsql`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
          values (${fundFrom.id}, ${fundTo.id}, 750000, (now() at time zone 'America/Bogota')::date)`,
      );

      // Limb three: a movement owned by someone who neither recorded it nor owns an account. The
      // scope trigger stands down only when `auth.uid()` is null, so the claims go with the role.
      await tx.execute(dsql`reset role`);
      await tx.execute(dsql`select set_config('request.jwt.claims', '', true)`);
      await tx.execute(
        dsql`insert into transactions (owner_user_id, from_account_id, to_account_id, amount_cents, occurred_at, created_by)
          values (${ownerUser}, ${holderFrom.id}, ${holderTo.id}, 250000,
            (now() at time zone 'America/Bogota')::date, ${leaderUser})`,
      );

      await enter(tx, leaderUser);
      const transferred = await tx.execute<{ ok: boolean }>(
        dsql`select private.transfer_group_leadership(${targetRow.id}) as ok`,
      );
      await tx.execute(dsql`reset role`);
      const roles = await tx.execute<{ id: string; role: string }>(
        dsql`select id, role from group_members
          where group_id = ${groupId} and role = 'leader' and archived_at is null`,
      );
      const [outgoing] = await tx.execute<{ role: string }>(
        dsql`select role from group_members where id = ${leaderRow.id}`,
      );
      assert(
        labels[0],
        transferred[0]?.ok === true &&
          roles.length === 1 &&
          roles[0].id === targetRow.id &&
          outgoing.role === "member",
        `the call returned ${transferred[0]?.ok}, live leaders = ${roles.length} (${roles[0]?.id === targetRow.id ? "the former target" : "someone else"}), the outgoing leader now reads '${outgoing.role}'`,
      );

      // 256: the swap is complete, so the demoted caller is refused at the role gate — the seat is
      // not handed back by asking for it.
      await enter(tx, leaderUser);
      const demotedRefusal = await transferRefusal(accountRow.id);
      assert(
        labels[1],
        demotedRefusal.includes("23514") && demotedRefusal.includes("only the leader transfers"),
        demotedRefusal,
      );

      // 257 and 258: the sitting leader is the caller now, so only the target's own shape refuses.
      await enter(tx, targetUser);
      const ghostRefusal = await transferRefusal(ghostRow.id);
      assert(
        labels[2],
        ghostRefusal.includes("23514") && ghostRefusal.includes("no login"),
        ghostRefusal,
      );

      const outsideRefusal = await transferRefusal(otherLeaderRow.id);
      assert(
        labels[3],
        outsideRefusal.includes("23514") && outsideRefusal.includes("not in the leader"),
        outsideRefusal,
      );

      // 259: `group_members_update_member` admits a member's own live row, so the policy alone lets
      // this update through — the absent column grant is the whole refusal. `name` is read back as
      // the control: an empty catalogue answer would otherwise report the gap by saying nothing.
      await tx.execute(dsql`reset role`);
      const memberUpdatable = await tx.execute<{ column_name: string }>(
        dsql`select column_name from information_schema.column_privileges
          where grantee = 'authenticated' and table_schema = 'finances'
            and table_name = 'group_members' and privilege_type = 'UPDATE'`,
      );
      const updatableColumns = memberUpdatable.map((row) => row.column_name);
      await enter(tx, leaderUser);
      const promotionRefusal = await refusalOf((sp) =>
        sp.execute(dsql`update group_members set role = 'leader' where id = ${leaderRow.id}`),
      );
      await tx.execute(dsql`reset role`);
      const [selfRole] = await tx.execute<{ role: string }>(
        dsql`select role from group_members where id = ${leaderRow.id}`,
      );
      assert(
        labels[4],
        !updatableColumns.includes("role") &&
          updatableColumns.includes("name") &&
          promotionRefusal.includes("42501") &&
          selfRole.role === "member",
        `authenticated updates [${updatableColumns.sort().join(", ")}]; ${promotionRefusal}; the row still reads '${selfRole.role}'`,
      );

      // 260: three members, one limb each. Each delete is the leader's own, so the delete policy
      // admits every one of them and the trigger is the only thing left to refuse.
      await enter(tx, targetUser);
      const deleteRefusal = async (member: string) => {
        let rows = -1;
        const refusal = await refusalOf(async (sp) => {
          const removed = await sp.execute<{ id: string }>(
            dsql`delete from group_members where id = ${member} returning id`,
          );
          rows = removed.length;
        });
        return { rows, refusal };
      };
      const accountLimb = await deleteRefusal(accountRow.id);
      const creatorLimb = await deleteRefusal(creatorRow.id);
      const ownerLimb = await deleteRefusal(ownerRow.id);
      await tx.execute(dsql`reset role`);
      const [{ count: survivors }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from group_members
          where id in (${accountRow.id}, ${creatorRow.id}, ${ownerRow.id}) and archived_at is null`,
      );
      assert(
        labels[5],
        accountLimb.refusal.includes("23514") &&
          creatorLimb.refusal.includes("23514") &&
          ownerLimb.refusal.includes("23514") &&
          survivors === "3",
        `accounts.owner_user_id → ${accountLimb.refusal}; transactions.created_by → ${creatorLimb.refusal}; transactions.owner_user_id → ${ownerLimb.refusal}; rows surviving = ${survivors}`,
      );

      // 261: the negative control. A row nobody ever claimed carries no trace to protect, so the
      // leader still empties her roster of the people she typed in herself.
      await enter(tx, targetUser);
      const ghostRemoved = await tx.execute<{ id: string }>(
        dsql`delete from group_members where id = ${ghostRow.id} returning id`,
      );
      assert(
        labels[6],
        ghostRemoved.length === 1,
        `rows removed = ${ghostRemoved.length}`,
      );

      // 262: accounts name a user or a group and never a member, so RF-61's first clause is that
      // archiving the person leaves what they own exactly where it stood.
      const archived = await tx.execute<{ archived_at: string | null }>(
        dsql`update group_members set archived_at = now()
          where id = ${accountRow.id} returning archived_at::text`,
      );
      await tx.execute(dsql`reset role`);
      const holderAccounts = await tx.execute<{ archived_at: string | null; owner_user_id: string }>(
        dsql`select archived_at::text, owner_user_id from accounts
          where id in (${holderFrom.id}, ${holderTo.id})`,
      );
      assert(
        labels[7],
        archived.length === 1 &&
          archived[0].archived_at !== null &&
          holderAccounts.length === 2 &&
          holderAccounts.every(
            (row) => row.archived_at === null && row.owner_user_id === accountUser,
          ),
        `the member reads archived_at = ${archived[0]?.archived_at}; ${holderAccounts.length} accounts, ${holderAccounts.filter((row) => row.archived_at === null && row.owner_user_id === accountUser).length} of them live and still theirs`,
      );

      // 263: RF-45. Both sides of the swap are ordinary updates as far as the audit trigger goes,
      // and the actor is the outgoing leader even though the function runs as the owner.
      const audited = await tx.execute<{ record_id: string; after_role: string }>(
        dsql`select record_id, after_data->>'role' as after_role from audit_log
          where entity = 'group_members' and action = 'UPDATE'
            and actor_user_id = ${leaderUser}
            and record_id in (${leaderRow.id}, ${targetRow.id})`,
      );
      const promoted = audited.find((row) => row.record_id === targetRow.id);
      const demoted = audited.find((row) => row.record_id === leaderRow.id);
      assert(
        labels[8],
        audited.length === 2 && promoted?.after_role === "leader" && demoted?.after_role === "member",
        `${audited.length} audit rows; the target became '${promoted?.after_role}', the caller '${demoted?.after_role}'`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select
      (select count(*) from groups where name like 'rls leader transfer%')
      + (select count(*) from accounts where name like 'rls leader transfer%') as count`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls leader transfer%' = ${probeCount}`,
  );
}

// Assertions 265-274: RF-61, RF-11's accounts half and the one read RF-58 never had asserted.
// `private.hand_account_to_group` landed with 0027 and was narrowed by 0028, and nothing standing
// named it either. The refusals are executed calls, and the three that 0028 collapsed into one
// message are compared to each other with the account id masked out, so a lookup that told a caller
// which of the three it was would turn the assertion red. Fixtures live in one transaction forced
// to roll back; each barred statement sits in a savepoint.
async function checkAccountHandOver() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const outsiderUser = randomUUID();
  const otherLeaderUser = randomUUID();
  const groupId = randomUUID();
  const otherGroupId = randomUUID();
  const missingAccount = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "265. a member hands a history-free account to the group and it lands as a shared group account",
    "266. the leader could not write that account before the hand-over and writes it after",
    "267. an account carrying a movement is refused the hand-over and keeps its owner",
    "268. an account already in the group is refused a second hand-over",
    "269. another person's account, another group's, and no row at all answer the same refusal",
    "270. authenticated holds no UPDATE on accounts.owner_user_id or accounts.group_id",
    "271. deleting the account carrying a movement is refused",
    "272. archiving that same account stands and its movement is untouched",
    "273. a user in no group reads neither the member's personal account nor the group's",
  ];
  const tailLabel = "274. the rolled-back hand-over transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  // The refusals 0028 unified name the account they were asked about, so the id is what has to go
  // before three messages can be compared for being one message.
  const maskIds = (message: string) =>
    message.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, "<account>");

  await orm
    .transaction(async (tx) => {
      const refusalOf = async (run: (sp: OrmTx) => Promise<unknown>): Promise<string> => {
        let refusal = "no refusal — the statement was accepted";
        await tx
          .transaction(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            refusal = describeRefusal(error);
          });
        return refusal;
      };

      const handOverRefusal = (account: string) =>
        refusalOf((sp) => sp.execute(dsql`select private.hand_account_to_group(${account})`));

      await tx.execute(dsql`insert into auth.users (id) values
        (${leaderUser}), (${memberUser}), (${outsiderUser}), (${otherLeaderUser})`);
      await tx.execute(dsql`insert into app_users (id) values
        (${leaderUser}), (${memberUser}), (${outsiderUser}), (${otherLeaderUser})`);

      // The group's id is supplied client-side: an unclaimed group fails its own SELECT policy.
      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls hand over', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls hand over leader', 'leader')`,
      );
      const [leaderAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_on)
          values (${leaderUser}, 'rls hand over leader cash', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );

      // No policy lets one member hand another their login, so the claimed rows are seeded as `postgres`.
      await tx.execute(dsql`reset role`);
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${memberUser}, 'rls hand over member', 'member')`,
      );
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${otherGroupId}, 'rls hand over other', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${otherGroupId}, ${otherLeaderUser}, 'rls hand over other leader', 'leader')`,
      );

      await enter(tx, otherLeaderUser);
      const [otherGroupAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
          values (${otherGroupId}, true, 'rls hand over other fund', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );

      // One account with nothing behind it and two carrying the transfer between them.
      await enter(tx, memberUser);
      const [freeAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_on)
          values (${memberUser}, 'rls hand over free', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );
      const [usedAccount] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_on)
          values (${memberUser}, 'rls hand over used', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );
      const [usedTarget] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_on)
          values (${memberUser}, 'rls hand over used target', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );
      const [movement] = await tx.execute<{ id: string }>(
        dsql`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
          values (${usedAccount.id}, ${usedTarget.id}, 430000,
            (now() at time zone 'America/Bogota')::date) returning id`,
      );

      // Read the leader's reach before the hand-over: `can_write_account` sees a personal account of
      // someone else and filters the row out, so the update reports the row it never saw.
      await enter(tx, leaderUser);
      const leaderBefore = await tx.execute<{ id: string }>(
        dsql`update accounts set name = 'rls hand over seized'
          where id = ${freeAccount.id} returning id`,
      );

      await enter(tx, memberUser);
      const handed = await tx.execute<{ ok: boolean }>(
        dsql`select private.hand_account_to_group(${freeAccount.id}) as ok`,
      );
      await tx.execute(dsql`reset role`);
      const [placed] = await tx.execute<{
        owner_user_id: string | null;
        group_id: string | null;
        is_shared: boolean;
        scopes: number;
      }>(
        dsql`select owner_user_id, group_id, is_shared,
            num_nonnulls(owner_user_id, group_id) as scopes
          from accounts where id = ${freeAccount.id}`,
      );
      assert(
        labels[0],
        handed[0]?.ok === true &&
          placed.owner_user_id === null &&
          placed.group_id === groupId &&
          placed.is_shared === true &&
          Number(placed.scopes) === 1,
        `the call returned ${handed[0]?.ok}; owner_user_id = ${placed.owner_user_id ?? "null"}, group_id = ${placed.group_id === groupId ? "the caller's group" : (placed.group_id ?? "null")}, is_shared = ${placed.is_shared}, num_nonnulls(owner, group) = ${placed.scopes}`,
      );

      await enter(tx, leaderUser);
      const leaderSees = await tx.execute<{ id: string }>(
        dsql`select id from accounts where id = ${freeAccount.id}`,
      );
      const leaderAfter = await tx.execute<{ id: string }>(
        dsql`update accounts set name = 'rls hand over shared'
          where id = ${freeAccount.id} returning id`,
      );
      assert(
        labels[1],
        leaderBefore.length === 0 && leaderSees.length === 1 && leaderAfter.length === 1,
        `before the hand-over the leader's update touched ${leaderBefore.length} rows; after it she reads ${leaderSees.length} row and updates ${leaderAfter.length}`,
      );

      await enter(tx, memberUser);
      const usedRefusal = await handOverRefusal(usedAccount.id);
      await tx.execute(dsql`reset role`);
      const [usedStill] = await tx.execute<{ owner_user_id: string | null; group_id: string | null }>(
        dsql`select owner_user_id, group_id from accounts where id = ${usedAccount.id}`,
      );
      assert(
        labels[2],
        usedRefusal.includes("23514") &&
          usedRefusal.includes("carries history") &&
          usedStill.owner_user_id === memberUser &&
          usedStill.group_id === null,
        `${usedRefusal}; the account still names ${usedStill.owner_user_id === memberUser ? "its owner" : "someone else"} and group_id = ${usedStill.group_id ?? "null"}`,
      );

      // 268: the caller's own group is the one scope whose account she already reads, so naming it
      // discloses nothing a plain select does not — and it is the only branch that may say so.
      await enter(tx, memberUser);
      const secondRefusal = await handOverRefusal(freeAccount.id);
      assert(
        labels[3],
        secondRefusal.includes("23514") && secondRefusal.includes("already belongs to a group"),
        secondRefusal,
      );

      // 269: everything outside the caller's reach answers alike. Before 0028 the lookup read the
      // account by id alone, so these three told the caller apart from one another.
      const strangerRefusal = maskIds(await handOverRefusal(leaderAccount.id));
      const otherGroupRefusal = maskIds(await handOverRefusal(otherGroupAccount.id));
      const missingRefusal = maskIds(await handOverRefusal(missingAccount));
      assert(
        labels[4],
        strangerRefusal.includes("23514") &&
          strangerRefusal === otherGroupRefusal &&
          otherGroupRefusal === missingRefusal,
        `another person's → ${strangerRefusal}; another group's → ${otherGroupRefusal}; no row → ${missingRefusal}`,
      );

      // 270: `accounts_update_writable` admits the owner's own row, so the policy alone would let a
      // caller repoint her account into any group. The absent column grant is what refuses it.
      await tx.execute(dsql`reset role`);
      const accountUpdatable = await tx.execute<{ column_name: string }>(
        dsql`select column_name from information_schema.column_privileges
          where grantee = 'authenticated' and table_schema = 'finances'
            and table_name = 'accounts' and privilege_type = 'UPDATE'`,
      );
      const updatableColumns = accountUpdatable.map((row) => row.column_name);
      await enter(tx, memberUser);
      const repointRefusal = await refusalOf((sp) =>
        sp.execute(dsql`update accounts set owner_user_id = null, group_id = ${groupId}
          where id = ${usedAccount.id}`),
      );
      assert(
        labels[5],
        !updatableColumns.includes("owner_user_id") &&
          !updatableColumns.includes("group_id") &&
          updatableColumns.includes("name") &&
          repointRefusal.includes("42501"),
        `authenticated updates [${updatableColumns.sort().join(", ")}]; ${repointRefusal}`,
      );

      // 271 and 272: RF-11's accounts half. `transactions.from_account_id` is `on delete restrict`,
      // and the copy the action layer answers with — "archívala en su lugar" — is only true if the
      // archive it points at actually stands.
      let deleteRows = -1;
      const deleteRefusal = await refusalOf(async (sp) => {
        const rows = await sp.execute<{ id: string }>(
          dsql`delete from accounts where id = ${usedAccount.id} returning id`,
        );
        deleteRows = rows.length;
      });
      assert(
        labels[6],
        deleteRefusal.includes("23503") && deleteRows === -1,
        `${deleteRefusal}, rows removed = ${deleteRows === -1 ? "none — the statement raised" : deleteRows}`,
      );

      const archivedAccount = await tx.execute<{ archived_at: string | null }>(
        dsql`update accounts set archived_at = now()
          where id = ${usedAccount.id} returning archived_at::text`,
      );
      const [movementAfter] = await tx.execute<{ amount_cents: string; from_account_id: string }>(
        dsql`select amount_cents::text, from_account_id from transactions where id = ${movement.id}`,
      );
      assert(
        labels[7],
        archivedAccount.length === 1 &&
          archivedAccount[0].archived_at !== null &&
          movementAfter.amount_cents === "430000" &&
          movementAfter.from_account_id === usedAccount.id,
        `archived_at = ${archivedAccount[0]?.archived_at}; the movement still reads ${movementAfter?.amount_cents} cents out of the same account`,
      );

      // 273: RF-58 stops at the group's edge. Proved for a group account (121) and never for a
      // personal one, whose reach runs through `owner_group_id` instead of the row's own group.
      await enter(tx, outsiderUser);
      const [{ count: outsiderPersonal }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from accounts where id = ${usedAccount.id}`,
      );
      const [{ count: outsiderShared }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from accounts where id = ${freeAccount.id}`,
      );
      await enter(tx, memberUser);
      const [{ count: memberPersonal }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from accounts where id = ${usedAccount.id}`,
      );
      const [{ count: memberShared }] = await tx.execute<{ count: string }>(
        dsql`select count(*)::text as count from accounts where id = ${freeAccount.id}`,
      );
      await tx.execute(dsql`reset role`);
      assert(
        labels[8],
        outsiderPersonal === "0" &&
          outsiderShared === "0" &&
          memberPersonal === "1" &&
          memberShared === "1",
        `the outsider reads ${outsiderPersonal} personal and ${outsiderShared} group rows; the member reads ${memberPersonal} and ${memberShared} of the same two`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select
      (select count(*) from groups where name like 'rls hand over%')
      + (select count(*) from accounts where name like 'rls hand over%') as count`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls hand over%' = ${probeCount}`,
  );
}

// Assertions 277-280: the currency layer 0031 and 0032 shipped. `account_balances` was dropped and
// recreated, and Supabase hands the client roles a grant at creation, so the view's own privileges are
// read back from the catalogue alongside `security_invoker` — without that flag the view would read
// with its owner's rights and walk past the policies of whoever queries it. The two triggers are then
// driven as a real user, never asserted from the migration: one derives the currency a writer does not
// name, which is what keeps the ten existing insert paths alive; the other refuses with `23901` a
// movement whose second amount is missing, surplus, or attached to a shape that cannot carry it.
async function checkCurrencyPolicies() {
  console.log("");
  const subject = randomUUID();

  const labels = [
    "277. authenticated holds SELECT and nothing else on account_balances, and the view reads as its caller",
    "278. a writer that names no currency gets the account's, from the source or from the destination",
    "279. a movement in another currency is refused without its counter amount, accepted with it, and refused for carrying one it does not need",
    "280. a cross-currency transfer booked in a third currency and an estimate on a two-sided movement are both refused",
  ];
  const tailLabel = "281. the rolled-back currency transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  const viewGrants = await sql<{ role: string; priv: string }[]>`
    select a.grantee::regrole::text as role, a.privilege_type as priv
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
    where c.oid = 'finances.account_balances'::regclass
      and a.grantee::regrole::text in ('anon', 'authenticated', 'service_role')
    order by a.grantee::regrole::text, a.privilege_type`;
  const [{ invoker }] = await sql<{ invoker: boolean }[]>`
    select coalesce('security_invoker=on' = any(c.reloptions), false) as invoker
    from pg_class c where c.oid = 'finances.account_balances'::regclass`;

  const handed = viewGrants.map((row) => `${row.role}:${row.priv}`).join(", ");
  assert(
    labels[0],
    handed === "authenticated:SELECT" && invoker === true,
    `the client roles hold [${handed || "nothing"}], security_invoker = ${invoker}`,
  );

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject})`;
      await tx`insert into app_users (id) values (${subject})`;
      await enterUserContext(tx, subject);

      const [{ id: pesos }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${subject}, 'rls currency pesos', 'asset', 1000000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: dollars }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, settlement_currency, initial_balance_cents, initial_balance_on)
        values (${subject}, 'rls currency dollars', 'asset', 'USD', 100000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: expenseCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${subject}, 'rls currency expense', 'expense') returning id`;
      const [{ id: incomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${subject}, 'rls currency income', 'income') returning id`;

      // 278: neither insert names a currency, which is how every path written before 0031 writes. The
      // expense takes the source account's, the income the destination's, and the derived value is what
      // decides the pocket the view files the movement under.
      const [spent] = await tx<{ id: string; currency: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${pesos}, 20000, (now() at time zone 'America/Bogota')::date) returning id, currency`;
      const [earned] = await tx<{ id: string; currency: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at)
        values (${dollars}, 5000, (now() at time zone 'America/Bogota')::date) returning id, currency`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values
        (${spent.id}, ${expenseCat}, 20000),
        (${earned.id}, ${incomeCat}, 5000)`;
      const pockets = await tx<{ currency: string; balance_cents: string }[]>`
        select currency, balance_cents::text from account_balances where id = ${dollars} order by currency`;
      assert(
        labels[1],
        spent.currency === "COP" &&
          earned.currency === "USD" &&
          pockets.length === 1 &&
          pockets[0].currency === "USD" &&
          pockets[0].balance_cents === "105000",
        `the expense out of the peso account = ${spent.currency} (expected COP), the income into the dollar account = ${earned.currency} (expected USD), pockets = ${pockets.map((row) => `${row.currency} ${row.balance_cents}`).join(", ")} (expected USD 105000)`,
      );

      // Each refusal runs in its own savepoint, so a statement that is wrongly accepted leaves no row
      // behind for the next one to trip over.
      const refusalCode = async (
        run: (sp: postgres.TransactionSql) => Promise<unknown>,
      ): Promise<string> => {
        const discard = Symbol("discard the savepoint");
        let code = "no refusal — the statement was accepted";
        await tx
          .savepoint(async (sp) => {
            await run(sp);
            throw discard;
          })
          .catch((error: unknown) => {
            if (error !== discard) code = pgErrorCode(error) ?? "none";
          });
        return code;
      };

      // 279: spending pesos out of a dollar account needs the amount in dollars beside it, and spending
      // pesos out of a peso account may not carry a second amount at all. The accepted one in between is
      // the negative control: the trigger admits the shape it asks for.
      const missingCounter = await refusalCode(
        (sp) => sp`insert into transactions (from_account_id, amount_cents, occurred_at, currency)
          values (${dollars}, 80000, (now() at time zone 'America/Bogota')::date, 'COP')`,
      );
      const surplusCounter = await refusalCode(
        (sp) => sp`insert into transactions (from_account_id, amount_cents, occurred_at, currency, counter_amount_cents)
          values (${pesos}, 20000, (now() at time zone 'America/Bogota')::date, 'COP', 5000)`,
      );
      const [abroad] = await tx<{ id: string; currency: string; counter_amount_cents: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, currency, counter_amount_cents)
        values (${dollars}, 80000, (now() at time zone 'America/Bogota')::date, 'COP', 20)
        returning id, currency, counter_amount_cents`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${abroad.id}, ${expenseCat}, 80000)`;
      assert(
        labels[2],
        missingCounter === "23901" &&
          surplusCounter === "23901" &&
          abroad.currency === "COP" &&
          abroad.counter_amount_cents === "20",
        `no counter = ${missingCounter}, surplus counter = ${surplusCounter} (both expected 23901); the movement that carried one landed as ${abroad.currency} with counter ${abroad.counter_amount_cents}`,
      );

      // 280: a transfer between two currencies is booked in one of them and never in a third, and an
      // estimate waits for a statement, which only a one-sided movement ever gets.
      const thirdCurrency = await refusalCode(
        (sp) => sp`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at, currency, counter_amount_cents)
          values (${pesos}, ${dollars}, 40000, (now() at time zone 'America/Bogota')::date, 'EUR', 10)`,
      );
      const estimateOnTransfer = await refusalCode(
        (sp) => sp`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at, currency, counter_amount_cents, counter_is_estimate)
          values (${pesos}, ${dollars}, 40000, (now() at time zone 'America/Bogota')::date, 'COP', 10, true)`,
      );
      assert(
        labels[3],
        thirdCurrency === "23901" && estimateOnTransfer === "23901",
        `a transfer booked in a third currency = ${thirdCurrency}, an estimate on a transfer = ${estimateOnTransfer} (both expected 23901)`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls currency%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls currency%' = ${probeCount}`,
  );
}

// Assertion 283: 0032's `GRANT UPDATE (currency, counter_amount_cents, counter_is_estimate)`
// and `GRANT INSERT (currency, counter_amount_cents, counter_is_estimate)` widen what a
// writer may SET on a transaction, never who counts as one. Driven as an outsider who
// shares no account with the owner: her UPDATE of the counter amount matches no row —
// caught twice over, first by `transactions_select_member` denying her the row at all,
// then by `transactions_update_writable`'s own USING/WITH CHECK, each sufficient alone
// (confirmed by widening one at a time: neither breach alone lets the write through, and
// widening both together does) — and her INSERT naming the owner's account is refused
// outright by `transactions_insert_writable`, before the currency triggers ever see the row.
async function checkCounterAmountWriteScope() {
  console.log("");
  const owner = randomUUID();
  const outsider = randomUUID();

  const label =
    "283. an outsider's write of counter_amount_cents reaches no transaction she cannot already write";
  const tailLabel = "284. the rolled-back counter-amount-scope transaction leaves no trace";
  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${owner}), (${outsider})`;
      await tx`insert into app_users (id) values (${owner}), (${outsider})`;
      await enterUserContext(tx, owner);

      const [{ id: dollars }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, settlement_currency, initial_balance_cents, initial_balance_on)
        values (${owner}, 'rls counter scope dollars', 'asset', 'USD', 100000, (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: incomeCat }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${owner}, 'rls counter scope income', 'income') returning id`;
      const [abroad] = await tx<{ id: string; counter_amount_cents: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at, currency, counter_amount_cents)
        values (${dollars}, 5000, (now() at time zone 'America/Bogota')::date, 'COP', 20)
        returning id, counter_amount_cents`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${abroad.id}, ${incomeCat}, 5000)`;

      // The UPDATE: the outsider names the owner's row, but `can_write_transaction` fails
      // her on the destination account, so the statement is admitted and touches nothing —
      // the same silence a denied UPDATE leaves on any other column.
      await enterUserContext(tx, outsider);
      const outsiderUpdate = await tx<{ id: string }[]>`
        update transactions set counter_amount_cents = 999999
        where id = ${abroad.id} returning id`;

      // The INSERT: naming the same account from scratch, in its own savepoint so a
      // wrongly-accepted row does not linger for the read below.
      const discard = Symbol("discard the savepoint");
      let insertCode = "no refusal — the statement was accepted";
      await tx
        .savepoint(async (sp) => {
          await sp`insert into transactions (to_account_id, amount_cents, occurred_at, currency, counter_amount_cents)
            values (${dollars}, 3000, (now() at time zone 'America/Bogota')::date, 'COP', 15)`;
          throw discard;
        })
        .catch((error: unknown) => {
          if (error !== discard) insertCode = pgErrorCode(error) ?? "none";
        });

      // Read back as the owner: the assertion is about what the row STORES, never what the
      // outsider was shown.
      await enterUserContext(tx, owner);
      const [{ counter_amount_cents: stillOriginal }] = await tx<
        { counter_amount_cents: string }[]
      >`select counter_amount_cents::text from transactions where id = ${abroad.id}`;

      assert(
        label,
        outsiderUpdate.length === 0 &&
          insertCode === "42501" &&
          stillOriginal === abroad.counter_amount_cents,
        `outsider update rows = ${outsiderUpdate.length}, outsider insert = ${insertCode} (expected 42501), counter after = ${stillOriginal} (expected ${abroad.counter_amount_cents})`,
      );

      // Nothing this section wrote may survive; force the ROLLBACK.
      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls counter scope%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls counter scope%' = ${probeCount}`,
  );
}

// Assertions 285-286: `private.run_due_recurring_rules(uuid)` (D10) scopes the generator by
// `created_by` when named one, and sweeps every due rule when called with no argument — the exact
// text pg_cron still runs. Driven with the JWT cleared, the way both the cron and a seed call it.
async function checkRecurringRuleGeneratorScope() {
  console.log("");
  const userA = randomUUID();
  const userB = randomUUID();

  const labels = [
    "285. a call scoped to one user runs that user's due rule and leaves the other user's untouched",
    "286. the same rules, then called with no argument, run the one the scoped call had left alone",
  ];
  const tailLabel = "287. the rolled-back recurring-rule-scope transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${userA}), (${userB})`;
      await tx`insert into app_users (id) values (${userA}), (${userB})`;

      // Each user with their own personal account, expense category and a rule due today, so one
      // generation lands exactly one transaction and clears the due window.
      await enterUserContext(tx, userA);
      const [{ id: accountA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${userA}, 'rls recurring scope a cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: catA }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${userA}, 'rls recurring scope a expense', 'expense') returning id`;
      const [{ id: ruleA }] = await tx<{ id: string }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on)
        values (${accountA}, 3000, ${catA}, 'weekly', 1, (now() at time zone 'America/Bogota')::date) returning id`;

      await tx`reset role`;
      await enterUserContext(tx, userB);
      const [{ id: accountB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${userB}, 'rls recurring scope b cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: catB }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${userB}, 'rls recurring scope b expense', 'expense') returning id`;
      const [{ id: ruleB }] = await tx<{ id: string }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on)
        values (${accountB}, 4500, ${catB}, 'weekly', 1, (now() at time zone 'America/Bogota')::date) returning id`;

      // Scoped to A, with no JWT — the shape a fixture or a seed calls it in, not the cron's own.
      await tx`reset role`;
      await tx`select set_config('request.jwt.claims', '', true)`;
      await tx`select private.run_due_recurring_rules(${userA}::uuid)`;

      const [{ count: aRanScoped }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where recurring_rule_id = ${ruleA}`;
      const [{ count: bRanScoped }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where recurring_rule_id = ${ruleB}`;
      assert(
        labels[0],
        aRanScoped === "1" && bRanScoped === "0",
        `scoped to A: A's transactions = ${aRanScoped} (expected 1), B's transactions = ${bRanScoped} (expected 0)`,
      );

      // The unscoped call — pg_cron's own stored text — reaches the rule the scoped call left alone.
      await tx`select private.run_due_recurring_rules()`;

      const [{ count: aRanUnscoped }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where recurring_rule_id = ${ruleA}`;
      const [{ count: bRanUnscoped }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where recurring_rule_id = ${ruleB}`;
      assert(
        labels[1],
        aRanUnscoped === "1" && bRanUnscoped === "1",
        `unscoped: A's transactions = ${aRanUnscoped} (expected 1, unchanged), B's transactions = ${bRanUnscoped} (expected 1)`,
      );

      // Forces the deferred split-sum trigger now, proving both generated movements balance their split.
      await tx`set constraints all immediate`;

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls recurring scope%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls recurring scope%' = ${probeCount}`,
  );
}

// Assertions 288-293: the period any account closes (RF-129, RF-130). The table no longer keeps an
// invented interest estimate, an asset closes a period with neither a due date nor a minimum, the
// bounds and the one-per-cut-off key still hold, the client roles hold only the column grants
// `authenticated` writes through, and the trail names the table by its new name. Every fixture is
// seeded through the app's own policies and rolled back.
async function checkAccountStatementShape() {
  console.log("");
  const subject = randomUUID();

  const labels = [
    "288. account_statements carries no interest estimate and lets an asset leave the due date empty",
    "289. an asset closes a period with no due date and no minimum",
    "290. a due date before the cut-off is refused",
    "291. a second statement on the same account and cut-off is refused",
    "292. anon and service_role hold nothing on the table, and authenticated holds column grants only",
    "293. the asset close left an audit_log row naming account_statements",
  ];
  const tailLabel = "294. the rolled-back account statement shape transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  // 288: read off the live catalogue, never off the migration.
  const shape = await sql<{ column_name: string; is_nullable: string }[]>`
    select column_name, is_nullable
    from information_schema.columns
    where table_schema = 'finances' and table_name = 'account_statements'`;
  const dueDate = shape.find((column) => column.column_name === "payment_due_date");
  assert(
    labels[0],
    shape.length > 0 &&
      !shape.some((column) => column.column_name === "interest_estimate_cents") &&
      dueDate?.is_nullable === "YES",
    `columns = ${shape.length}, interest_estimate_cents = ${
      shape.some((column) => column.column_name === "interest_estimate_cents") ? "present" : "gone"
    }, payment_due_date nullable = ${dueDate?.is_nullable ?? "no such column"}`,
  );

  // 292: a rename carries the old grants forward, so this reads both the table ACL and every column
  // ACL. `authenticated` must hold nothing table-wide — the column form is the whole grant.
  const tableAcl = await sql<{ role: string; priv: string }[]>`
    select a.grantee::regrole::text as role, a.privilege_type as priv
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
    where c.oid = 'finances.account_statements'::regclass
      and a.grantee::regrole::text in ('anon', 'authenticated', 'service_role')
    order by a.grantee::regrole::text, a.privilege_type`;
  const columnAcl = await sql<{ role: string; priv: string }[]>`
    select a.grantee::regrole::text as role, a.privilege_type as priv
    from pg_attribute att
    cross join lateral aclexplode(att.attacl) a
    where att.attrelid = 'finances.account_statements'::regclass
      and att.attnum > 0 and not att.attisdropped
      and a.grantee::regrole::text in ('anon', 'authenticated', 'service_role')
    order by a.grantee::regrole::text, a.privilege_type`;
  const strangers = [...tableAcl, ...columnAcl].filter((row) => row.role !== "authenticated");
  const columnPrivileges = [...new Set(columnAcl.map((row) => row.priv))].sort();

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${subject})`;
      await tx`insert into app_users (id) values (${subject})`;
      await enterUserContext(tx, subject);

      const [{ id: savings }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
        values (${subject}, 'rls account statement savings', 'asset', 1500000, (now() at time zone 'America/Bogota')::date) returning id`;

      const [dates] = await tx<{ cut_off: string; period_start: string; before_cut: string }[]>`
        select
          to_char((date_trunc('month', now() at time zone 'America/Bogota') - interval '1 day'), 'YYYY-MM-DD') as cut_off,
          to_char((date_trunc('month', now() at time zone 'America/Bogota') - interval '1 month'), 'YYYY-MM-DD') as period_start,
          to_char((date_trunc('month', now() at time zone 'America/Bogota') - interval '10 days'), 'YYYY-MM-DD') as before_cut`;

      // 289: a savings statement prints an opening and a closing figure and demands no payment. The
      // trigger that used to refuse every account but a liability is gone (RF-129).
      const closed = await tx<{ id: string; source: string }[]>`
        insert into account_statements
          (account_id, period_start, cut_off_date, opening_balance_cents, closing_balance_cents, credits_cents, debits_cents)
        values (${savings}, ${dates.period_start}, ${dates.cut_off}, 1200000, 1500000, 400000, 100000)
        returning id, source`;
      assert(
        labels[1],
        closed.length === 1 && closed[0].source === "recorded",
        `inserted rows = ${closed.length}, source = ${closed[0]?.source ?? "none"}`,
      );

      // 290: the due date is optional, but one that predates the cut-off is still a contradiction.
      let dueCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`insert into account_statements
            (account_id, period_start, cut_off_date, payment_due_date, closing_balance_cents)
            values (${savings}, ${dates.period_start}, ${dates.cut_off}, ${dates.before_cut}, 1500000)`;
        })
        .catch((error: unknown) => {
          dueCode = pgErrorCode(error);
        });
      assert(labels[2], dueCode === "23514", `sqlstate ${dueCode ?? "none"}`);

      // 291: the unique key survived the rename, so a period closes once.
      let duplicateCode: string | undefined;
      await tx
        .savepoint(async (sp) => {
          await sp`insert into account_statements
            (account_id, period_start, cut_off_date, closing_balance_cents)
            values (${savings}, ${dates.period_start}, ${dates.cut_off}, 1500000)`;
        })
        .catch((error: unknown) => {
          duplicateCode = pgErrorCode(error);
        });
      assert(labels[3], duplicateCode === "23505", `sqlstate ${duplicateCode ?? "none"}`);

      assert(
        labels[4],
        strangers.length === 0 &&
          !tableAcl.some((row) => row.role === "authenticated") &&
          columnPrivileges.join(",") === "INSERT,SELECT",
        `anon and service_role hold [${
          strangers.map((row) => `${row.role}:${row.priv}`).join(", ") || "nothing"
        }], authenticated holds [${
          tableAcl.map((row) => row.priv).join(", ") || "nothing"
        }] table-wide and [${columnPrivileges.join(", ") || "nothing"}] by column`,
      );

      // 293: the trail names the table through `tg_table_name`, so the rename carried it. The row
      // carries no owner — the table has no owner column — so it is counted as `postgres`.
      await tx`reset role`;
      const [{ count: trail }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log
        where entity = 'account_statements' and record_id = ${closed[0].id} and action = 'INSERT'`;
      assert(labels[5], trail === "1", `audit rows for the close = ${trail}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls account statement%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls account statement%' = ${probeCount}`,
  );

  // Every assertion above runs as `authenticated` because `enterUserContext`
  // puts it there itself. The app does not: it goes through
  // `settleSessionSql`, and the login role `postgres` holds BYPASSRLS. Drop
  // the role line from that one shared statement and this whole file stays
  // green while no policy fires in either app. So drive the statement rather
  // than mirror it, in a transaction that has not already been re-roled —
  // `set_config(…, true)` is transaction-local.
  await sql.begin(async (tx) => {
    const [before] = await tx<{ current_user: string }[]>`select current_user`;
    const claims = JSON.stringify({
      sub: randomUUID(),
      role: "authenticated",
      aud: "authenticated",
    });
    const settle = new PgDialect().sqlToQuery(
      settleSessionSql({ claims, searchPath: "finances, public" }),
    );
    await tx.unsafe(settle.sql, settle.params as string[]);
    const [after] = await tx<{ current_user: string; bypasses: boolean }[]>`
      select current_user,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypasses`;
    assert(
      "295. the shared settle statement is what lands the un-bypassing role",
      before.current_user !== "authenticated" &&
        after.current_user === "authenticated" &&
        after.bypasses === false,
      `role ${before.current_user} -> ${after.current_user}, bypassrls = ${after.bypasses}`,
    );
    await tx`reset role`;
  });
}

// Assertions 296-317: a reconciliation (RF-137, RF-138). The database books the gap as one marked,
// one-legged movement in the settlement currency, refuses every write the model forbids and audits
// both rows. Every probe runs as `authenticated`; fixtures land as the owner with the claims settled,
// and the whole section is one transaction forced to roll back.
async function checkAccountReconciliations() {
  console.log("");
  const owner = randomUUID();
  const member = randomUUID();
  const outsider = randomUUID();
  const groupId = randomUUID();

  const labels = [
    "296. a positive gap books one destination-only movement of the gap, on the day",
    "297. a negative gap books one source-only movement of the gap",
    "298. a liability's counted debt books its gap with the account's sign",
    "299. a zero gap records the reconciliation and books no movement",
    "300. the balance on the day and the account's settlement pocket equal the counted figure",
    "301. the adjustment is booked in the settlement currency and leaves the foreign pocket alone",
    "302. a split on an adjustment is refused when the constraint fires",
    "303. the owner's update of an adjustment touches nothing, while a plain movement still updates",
    "304. the owner's delete of an adjustment touches nothing",
    "305. a caller cannot name reconciliation_id on a movement",
    "306. a reconciliation refuses UPDATE and DELETE outright",
    "307. the owner and a member read the history, a user of another fund reads none",
    "308. a member who cannot write another member's personal account cannot reconcile it",
    "309. a day after today in Bogota is refused with RC001",
    "310. a day before the opening balance is refused with RC002",
    "311. a day before the latest reconciliation is refused with RC003, the same day is not",
    "312. an archived account is refused with RC004",
    "313. the reconciliation and its movement are each audited with the owner as actor",
    "314. anon and service_role hold nothing on the table, authenticated holds no UPDATE or DELETE",
    "315. the reconciliation is stamped with the caller and the movement takes the account's scope",
    "316. deleting an account an adjustment points at is still refused",
  ];
  const tailLabel = "317. the rolled-back reconciliation transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  // 314: read off the live catalogue, outside the transaction.
  const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  const held = await sql<{ role: string; priv: string; holds: boolean }[]>`
    select r.role, p.priv,
      -- A column grant is invisible to has_table_privilege; the column form reads both.
      case when p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
        then has_any_column_privilege(r.role, 'finances.account_reconciliations', p.priv)
        else has_table_privilege(r.role, 'finances.account_reconciliations', p.priv)
      end as holds
    from unnest(array['anon', 'service_role', 'authenticated']) as r(role)
    cross join unnest(${privileges}::text[]) as p(priv)`;
  const strayColumns = await sql<{ role: string; priv: string }[]>`
    select a.grantee::regrole::text as role, a.privilege_type as priv
    from pg_attribute att
    cross join lateral aclexplode(att.attacl) a
    where att.attrelid = 'finances.account_reconciliations'::regclass
      and att.attnum > 0 and not att.attisdropped
      and a.grantee::regrole::text in ('anon', 'service_role')`;
  const [fn] = await sql<{ anon: boolean; service: boolean; authenticated: boolean }[]>`
    select
      has_function_privilege('anon', 'private.account_settlement_balance_on(uuid, date)', 'execute') as anon,
      has_function_privilege('service_role', 'private.account_settlement_balance_on(uuid, date)', 'execute') as service,
      has_function_privilege('authenticated', 'private.account_settlement_balance_on(uuid, date)', 'execute') as authenticated`;
  const strangers = held.filter((row) => row.role !== "authenticated" && row.holds);
  const authHeld = held.filter((row) => row.role === "authenticated" && row.holds).map((row) => row.priv);
  assert(
    labels[18],
    strangers.length === 0 &&
      strayColumns.length === 0 &&
      authHeld.sort().join(",") === "INSERT,SELECT" &&
      !fn.anon &&
      !fn.service &&
      fn.authenticated,
    `anon and service_role hold [${
      [...strangers.map((row) => `${row.role}:${row.priv}`), ...strayColumns.map((row) => `${row.role}:${row.priv}:column`)].join(", ") || "nothing"
    }], authenticated holds [${authHeld.join(", ")}], balance function execute anon=${fn.anon} service_role=${fn.service} authenticated=${fn.authenticated}`,
  );

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${owner}), (${member}), (${outsider})`;
      await tx`insert into app_users (id) values (${owner}), (${member}), (${outsider})`;

      // The fixtures land as the owner role with the owner's claims, so every stamping trigger fires.
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: "authenticated", aud: "authenticated" })}, true)`;
      const [d] = await tx<{ today: string; tomorrow: string; opened: string; before_open: string; m10: string; m6: string; m5: string; m3: string; m2: string }[]>`
        select
          to_char(t, 'YYYY-MM-DD') as today,
          to_char(t + 1, 'YYYY-MM-DD') as tomorrow,
          to_char(t - 30, 'YYYY-MM-DD') as opened,
          to_char(t - 31, 'YYYY-MM-DD') as before_open,
          to_char(t - 10, 'YYYY-MM-DD') as m10,
          to_char(t - 6, 'YYYY-MM-DD') as m6,
          to_char(t - 5, 'YYYY-MM-DD') as m5,
          to_char(t - 3, 'YYYY-MM-DD') as m3,
          to_char(t - 2, 'YYYY-MM-DD') as m2
        from (select (now() at time zone 'America/Bogota')::date as t) x`;

      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls reconcile', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${groupId}, ${owner}, 'rls reconcile owner', 'leader'),
               (${groupId}, ${member}, 'rls reconcile member', 'member')`;

      const account = async (name: string, kind: "asset" | "liability", initial: number, currency = "COP") => {
        const [{ id }] = await tx<{ id: string }[]>`
          insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on, settlement_currency)
          values (${owner}, ${`rls reconcile ${name}`}, ${kind}, ${initial}, ${d.opened}, ${currency}) returning id`;
        return id;
      };
      const savings = await account("savings", "asset", 1000000);
      const spare = await account("spare", "asset", 0);
      const card = await account("card", "liability", -500000);
      const wallet = await account("wallet", "asset", 200000);
      const mixed = await account("mixed", "asset", 0);
      const ladder = await account("ladder", "asset", 0);
      const shelved = await account("shelved", "asset", 0);
      const [{ id: incomeCategory }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind) values (${owner}, 'rls reconcile income', 'income') returning id`;

      // Transfers carry no split, so the deferred split check stays quiet until 302 wakes it.
      const [{ id: plainTransfer }] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
        values (${spare}, ${savings}, 300000, ${d.m10}) returning id`;
      // A dollar income on a peso account, its peso figure still an estimate: a USD pocket of 50.00.
      const [{ id: dollars }] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, currency, counter_amount_cents, counter_is_estimate, occurred_at)
        values (${mixed}, 5000, 'USD', 20000000, true, ${d.m10}) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${dollars}, ${incomeCategory}, 5000)`;
      await tx`update accounts set archived_at = now() where id = ${shelved}`;

      type Adjustment = {
        id: string;
        from_account_id: string | null;
        to_account_id: string | null;
        amount_cents: string;
        currency: string;
        occurred_at: string;
        description: string | null;
        owner_user_id: string | null;
        group_id: string | null;
        created_by: string;
        kind: string;
      };
      const reconcile = async (accountId: string, day: string, counted: number) => {
        const [row] = await tx<{ id: string; created_by: string }[]>`
          insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
          values (${accountId}, ${day}, ${counted}) returning id, created_by`;
        const booked = await tx<Adjustment[]>`
          select id, from_account_id, to_account_id, amount_cents::text, currency, occurred_at::text,
            description, owner_user_id, group_id, created_by, kind
          from transactions where reconciliation_id = ${row.id}`;
        return { ...row, booked };
      };
      const derived = async (accountId: string, day: string) => {
        const [{ balance }] = await tx<{ balance: string }[]>`
          select private.account_settlement_balance_on(${accountId}, ${day}::date)::text as balance`;
        return Number(balance);
      };
      const refusal = async (run: (sp: postgres.TransactionSql) => Promise<unknown>) => {
        let code: string | undefined = "none — accepted";
        let message = "";
        await tx
          .savepoint(async (sp) => {
            await run(sp);
          })
          .catch((error: unknown) => {
            code = pgErrorCode(error);
            message = error instanceof Error ? error.message : String(error);
          });
        return { code, message };
      };

      await enterUserContext(tx, owner);

      // 296: 1 000 000 opening + 300 000 in, counted 1 200 000 over that.
      const before296 = await derived(savings, d.m5);
      const positive = await reconcile(savings, d.m5, before296 + 1200000);
      const [p] = positive.booked;
      assert(
        labels[0],
        before296 === 1300000 &&
          positive.booked.length === 1 &&
          p.to_account_id === savings &&
          p.from_account_id === null &&
          p.amount_cents === "1200000" &&
          p.occurred_at === d.m5 &&
          p.kind === "income" &&
          p.description === null,
        `derived ${before296}, booked ${positive.booked.length}: to ${p?.to_account_id === savings ? "the account" : p?.to_account_id}, from ${p?.from_account_id ?? "null"}, amount ${p?.amount_cents}, on ${p?.occurred_at} (day ${d.m5}), kind ${p?.kind}, description ${p?.description ?? "null"}`,
      );

      // 297: the same day again, counted 800 000 under what the ledger now says.
      const before297 = await derived(savings, d.m5);
      const negative = await reconcile(savings, d.m5, before297 - 800000);
      const [n] = negative.booked;
      assert(
        labels[1],
        before297 === 2500000 &&
          negative.booked.length === 1 &&
          n.from_account_id === savings &&
          n.to_account_id === null &&
          n.amount_cents === "800000" &&
          n.kind === "expense",
        `derived ${before297}, booked ${negative.booked.length}: from ${n?.from_account_id === savings ? "the account" : n?.from_account_id}, to ${n?.to_account_id ?? "null"}, amount ${n?.amount_cents}, kind ${n?.kind}`,
      );

      // 298: the card owes 500 000; the person counts 450 000 owed, so the debt shrinks by 50 000.
      const owed = await reconcile(card, d.m5, -450000);
      const [c] = owed.booked;
      assert(
        labels[2],
        owed.booked.length === 1 &&
          c.to_account_id === card &&
          c.from_account_id === null &&
          c.amount_cents === "50000",
        `booked ${owed.booked.length}: to ${c?.to_account_id === card ? "the card" : c?.to_account_id}, from ${c?.from_account_id ?? "null"}, amount ${c?.amount_cents}`,
      );

      // 299: counted exactly what the ledger says.
      const level = await reconcile(savings, d.m3, await derived(savings, d.m3));
      const [{ count: levelRows }] = await tx<{ count: string }[]>`
        select count(*)::text as count from account_reconciliations where id = ${level.id}`;
      assert(
        labels[3],
        levelRows === "1" && level.booked.length === 0,
        `reconciliation rows ${levelRows}, movements booked ${level.booked.length}`,
      );

      // 300: nothing later than the day moves the wallet, so its balance is the counted figure.
      await reconcile(wallet, d.m2, 750000);
      const onDay = await derived(wallet, d.m2);
      const [{ balance: pocket }] = await tx<{ balance: string }[]>`
        select balance_cents::text as balance from account_balances
        where id = ${wallet} and currency = 'COP'`;
      assert(
        labels[4],
        onDay === 750000 && pocket === "750000",
        `balance on ${d.m2} = ${onDay}, settlement pocket = ${pocket}`,
      );

      // 301: the mixed account holds USD 50.00 beside an empty peso pocket.
      const pockets = async () =>
        tx<{ currency: string; balance: string }[]>`
          select currency, balance_cents::text as balance from account_balances
          where id = ${mixed} order by currency`;
      const pocketsBefore = await pockets();
      const pesos = await reconcile(mixed, d.m5, 100000);
      const pocketsAfter = await pockets();
      const usd = (rows: { currency: string; balance: string }[]) =>
        rows.find((row) => row.currency === "USD")?.balance;
      assert(
        labels[5],
        pesos.booked.length === 1 &&
          pesos.booked[0].currency === "COP" &&
          pesos.booked[0].amount_cents === "100000" &&
          usd(pocketsBefore) === "5000" &&
          usd(pocketsAfter) === "5000",
        `booked ${pesos.booked.length} in ${pesos.booked[0]?.currency} for ${pesos.booked[0]?.amount_cents}; USD pocket ${usd(pocketsBefore)} -> ${usd(pocketsAfter)}`,
      );

      // 302: as the owner role, a split of the right category and the full amount. The first
      // `set constraints` is the control — every pending movement is sound until the split lands.
      await tx`reset role`;
      let control = "not run";
      await tx
        .savepoint(async (sp) => {
          await sp`set constraints all immediate`;
        })
        .then(() => {
          control = "accepted";
        })
        .catch((error: unknown) => {
          control = `refused ${pgErrorCode(error) ?? "none"}`;
        });
      let split = "none — accepted";
      await tx
        .savepoint(async (sp) => {
          await sp`set constraints all immediate`;
          await sp`insert into transaction_splits (transaction_id, category_id, amount_cents)
            values (${p.id}, ${incomeCategory}, 1200000)`;
        })
        .catch((error: unknown) => {
          split = `${pgErrorCode(error) ?? "none"} — ${error instanceof Error ? error.message : String(error)}`;
        });
      await tx`set constraints all deferred`;
      assert(
        labels[6],
        control === "accepted" && split.startsWith("23514") && split.includes("carries no split"),
        `pending movements ${control}; the split ${split}`,
      );
      await enterUserContext(tx, owner);

      // 303-304: the adjustment of 296 under the owner who booked it.
      const edited = await tx`update transactions set amount_cents = 1 where id = ${p.id} returning id`;
      const plainEdited = await tx`update transactions set amount_cents = 300001 where id = ${plainTransfer} returning id`;
      assert(
        labels[7],
        edited.length === 0 && plainEdited.length === 1,
        `adjustment rows updated ${edited.length}, plain transfer rows updated ${plainEdited.length}`,
      );
      const removed = await tx`delete from transactions where id = ${p.id} returning id`;
      const [{ count: kept }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where id = ${p.id}`;
      assert(
        labels[8],
        removed.length === 0 && kept === "1",
        `rows deleted ${removed.length}, adjustment still there ${kept}`,
      );

      // 305: a well-formed income that names the reconciliation of 297.
      const forged = await refusal((sp) => sp`
        insert into transactions (to_account_id, amount_cents, occurred_at, reconciliation_id)
        values (${spare}, 1000, ${d.m5}, ${negative.id})`);
      assert(labels[9], forged.code === "42501", `sqlstate ${forged.code} — ${forged.message}`);

      // 306
      const rewrite = await refusal((sp) => sp`
        update account_reconciliations set counted_balance_cents = 0 where id = ${positive.id}`);
      const erase = await refusal((sp) => sp`delete from account_reconciliations where id = ${positive.id}`);
      assert(
        labels[10],
        rewrite.code === "42501" && erase.code === "42501",
        `update sqlstate ${rewrite.code}, delete sqlstate ${erase.code}`,
      );

      // 307
      const visible = async (subject: string) => {
        await enterUserContext(tx, subject);
        const [{ count }] = await tx<{ count: string }[]>`
          select count(*)::text as count from account_reconciliations where account_id = ${savings}`;
        return count;
      };
      const ownerSees = await visible(owner);
      const memberSees = await visible(member);
      const outsiderSees = await visible(outsider);
      assert(
        labels[11],
        ownerSees === "3" && memberSees === "3" && outsiderSees === "0",
        `owner ${ownerSees}, member ${memberSees}, outsider ${outsiderSees}`,
      );

      // 308: the member reads the owner's savings (307) but writes only their own or a shared account.
      await enterUserContext(tx, member);
      const intrusion = await refusal((sp) => sp`
        insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${savings}, ${d.today}, 0)`);
      assert(labels[12], intrusion.code === "42501", `sqlstate ${intrusion.code} — ${intrusion.message}`);

      await enterUserContext(tx, owner);
      const attempt = (accountId: string, day: string) =>
        refusal((sp) => sp`
          insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
          values (${accountId}, ${day}, 0)`);

      // 309-310
      const future = await attempt(spare, d.tomorrow);
      assert(labels[13], future.code === "RC001", `sqlstate ${future.code} — ${future.message}`);
      const early = await attempt(spare, d.before_open);
      assert(labels[14], early.code === "RC002", `sqlstate ${early.code} — ${early.message}`);

      // 311
      await reconcile(ladder, d.m5, 0);
      const backwards = await attempt(ladder, d.m6);
      const sameDay = await attempt(ladder, d.m5);
      assert(
        labels[15],
        backwards.code === "RC003" && sameDay.code === "none — accepted",
        `day before the latest: sqlstate ${backwards.code}; the same day: ${sameDay.code}`,
      );

      // 312
      const archived = await attempt(shelved, d.m5);
      assert(labels[16], archived.code === "RC004", `sqlstate ${archived.code} — ${archived.message}`);

      // 316: the card's only movement is its adjustment, so nothing else holds the account.
      const dropCard = await refusal((sp) => sp`delete from accounts where id = ${card}`);

      // 313, 315: read as the owner role, which sees the trail.
      await tx`reset role`;
      const trail = await tx<{ entity: string; actor_user_id: string | null }[]>`
        select entity, actor_user_id from audit_log
        where action = 'INSERT' and (
          (entity = 'account_reconciliations' and record_id = ${positive.id})
          or (entity = 'transactions' and record_id = ${p.id}::text))
        order by entity`;
      assert(
        labels[17],
        trail.length === 2 &&
          trail[0].entity === "account_reconciliations" &&
          trail[1].entity === "transactions" &&
          trail.every((row) => row.actor_user_id === owner),
        `audit rows [${trail.map((row) => `${row.entity}:${row.actor_user_id === owner ? "owner" : row.actor_user_id}`).join(", ")}]`,
      );
      assert(
        labels[19],
        positive.created_by === owner &&
          p.owner_user_id === owner &&
          p.group_id === null &&
          p.created_by === owner,
        `reconciliation created_by ${positive.created_by === owner ? "owner" : positive.created_by}, movement owner ${p.owner_user_id === owner ? "owner" : p.owner_user_id}, group ${p.group_id ?? "null"}, created_by ${p.created_by === owner ? "owner" : p.created_by}`,
      );
      assert(labels[20], dropCard.code === "23503", `sqlstate ${dropCard.code} — ${dropCard.message}`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls reconcile%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls reconcile%' = ${probeCount}`,
  );
}

// Assertions 318-320: one bad recurring rule cannot stop the rest. A rule whose category belongs to
// another scope is inserted directly (the FK admits it; the action now refuses it), and the cron's own
// unscoped call must still generate the good rule's movement, skip the bad one and pause it, leaving the
// pause in the audit trail. Every fixture is seeded through the app's own policies and rolled back.
async function checkRecurringRuleIsolation() {
  console.log("");
  const userA = randomUUID();
  const userB = randomUUID();

  const labels = [
    "318. the unscoped generator still runs a good rule when another user's rule carries a category of the wrong scope",
    "319. the bad rule produced no movement and was paused, not left due to fail again",
    "320. the pause is recorded in the audit log",
  ];
  const tailLabel = "321. the rolled-back recurring-rule-isolation transaction leaves no trace";

  const forcedRollback = Symbol("forced rollback");

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${userA}), (${userB})`;
      await tx`insert into app_users (id) values (${userA}), (${userB})`;

      await enterUserContext(tx, userA);
      const [{ id: accountA }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${userA}, 'rls recurring isolation a cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: catA }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${userA}, 'rls recurring isolation a expense', 'expense') returning id`;
      const [{ id: goodRule }] = await tx<{ id: string }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on)
        values (${accountA}, 3000, ${catA}, 'weekly', 1, (now() at time zone 'America/Bogota')::date) returning id`;

      // B's expense rule points at A's category: another scope, which the split trigger refuses on generation.
      await tx`reset role`;
      await enterUserContext(tx, userB);
      const [{ id: accountB }] = await tx<{ id: string }[]>`
        insert into accounts (owner_user_id, name, kind, initial_balance_on)
        values (${userB}, 'rls recurring isolation b cash', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
      const [{ id: badRule }] = await tx<{ id: string }[]>`
        insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on)
        values (${accountB}, 4500, ${catA}, 'weekly', 1, (now() at time zone 'America/Bogota')::date) returning id`;

      await tx`reset role`;
      await tx`select set_config('request.jwt.claims', '', true)`;
      await tx`select private.run_due_recurring_rules()`;
      await tx`set constraints all immediate`;

      const [{ count: goodRan }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where recurring_rule_id = ${goodRule}`;
      assert(labels[0], goodRan === "1", `the good rule's movements = ${goodRan} (expected 1)`);

      const [{ count: badRan }] = await tx<{ count: string }[]>`
        select count(*)::text as count from transactions where recurring_rule_id = ${badRule}`;
      const [bad] = await tx<{ is_active: boolean }[]>`
        select is_active from recurring_rules where id = ${badRule}`;
      assert(
        labels[1],
        badRan === "0" && bad.is_active === false,
        `the bad rule's movements = ${badRan} (expected 0), is_active = ${bad.is_active} (expected false)`,
      );

      const [{ count: audited }] = await tx<{ count: string }[]>`
        select count(*)::text as count from audit_log
        where entity = 'recurring_rules' and record_id = ${badRule} and actor_user_id is null`;
      assert(labels[2], audited !== "0", `unattributed audit rows on the bad rule = ${audited} (expected at least 1)`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls recurring isolation%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls recurring isolation%' = ${probeCount}`,
  );
}

// Only the fund's leader toggles `is_shared` on a group account: a member's un-share would leave
// `can_write_account` false for everyone, leader included.
async function checkSharedToggleLeaderOnly() {
  console.log("");
  const leaderUser = randomUUID();
  const memberUser = randomUUID();
  const groupId = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "322. a member's update of is_shared on a group account is refused with 42501 and the account stays shared",
    "323. the same member still renames that shared account",
    "324. the leader's update of is_shared on the group account passes",
    "325. a personal account's owner still updates it, is_shared written unchanged",
    "326. the leader re-shares the account they un-shared",
    "327. a member cannot re-share an unshared group account",
  ];
  const tailLabel = "328. the rolled-back shared-toggle transaction leaves no trace";

  type OrmTx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const enter = (tx: OrmTx, subject: string) =>
    tx.execute(dsql`select
      set_config('request.jwt.claims', ${JSON.stringify({ sub: subject, role: "authenticated", aud: "authenticated" })}, true),
      set_config('statement_timeout', '8000', true),
      set_config('role', 'authenticated', true)`);

  await orm
    .transaction(async (tx) => {
      await tx.execute(dsql`insert into auth.users (id) values (${leaderUser}), (${memberUser})`);
      await tx.execute(dsql`insert into app_users (id) values (${leaderUser}), (${memberUser})`);

      await enter(tx, leaderUser);
      await tx.execute(
        dsql`insert into groups (id, name, cash_mode) values (${groupId}, 'rls shared toggle', 'shared')`,
      );
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${leaderUser}, 'rls shared toggle leader', 'leader')`,
      );
      const [shared] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
          values (${groupId}, true, 'rls shared toggle cash', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );

      await tx.execute(dsql`reset role`);
      await tx.execute(
        dsql`insert into group_members (group_id, user_id, name, role)
          values (${groupId}, ${memberUser}, 'rls shared toggle member', 'member')`,
      );
      const [ownPersonal] = await tx.execute<{ id: string }>(
        dsql`insert into accounts (owner_user_id, name, kind, initial_balance_on)
          values (${memberUser}, 'rls shared toggle own', 'asset',
            (now() at time zone 'America/Bogota')::date) returning id`,
      );

      await enter(tx, memberUser);
      let code: string | undefined = "none";
      await tx
        .transaction(async (sp) => {
          await sp.execute(dsql`update accounts set is_shared = false where id = ${shared.id}`);
        })
        .catch((error: unknown) => {
          code = pgErrorCode(error) ?? "unknown";
        });
      const [afterMember] = await tx.execute<{ is_shared: boolean }>(
        dsql`select is_shared from accounts where id = ${shared.id}`,
      );
      assert(
        labels[0],
        code === "42501" && afterMember.is_shared === true,
        `error code = ${code} (expected 42501), is_shared = ${afterMember.is_shared} (expected true)`,
      );

      const renamed = await tx.execute<{ id: string }>(
        dsql`update accounts set name = 'rls shared toggle renamed' where id = ${shared.id} returning id`,
      );
      assert(labels[1], renamed.length === 1, `rows renamed = ${renamed.length} (expected 1)`);

      await enter(tx, leaderUser);
      const unshared = await tx.execute<{ id: string }>(
        dsql`update accounts set is_shared = false where id = ${shared.id} returning id`,
      );
      assert(labels[2], unshared.length === 1, `rows updated = ${unshared.length} (expected 1)`);

      const reshared = await tx.execute<{ id: string }>(
        dsql`update accounts set is_shared = true where id = ${shared.id} returning id`,
      );
      assert(labels[4], reshared.length === 1, `rows re-shared by the leader = ${reshared.length} (expected 1)`);
      await tx.execute(dsql`update accounts set is_shared = false where id = ${shared.id}`);

      await enter(tx, memberUser);
      const memberReshare = await tx.execute<{ id: string }>(
        dsql`update accounts set is_shared = true where id = ${shared.id} returning id`,
      );
      assert(labels[5], memberReshare.length === 0, `rows re-shared by a member = ${memberReshare.length} (expected 0)`);
      const toggled = await tx.execute<{ id: string }>(
        dsql`update accounts set is_shared = false, name = 'rls shared toggle own 2' where id = ${ownPersonal.id} returning id`,
      );
      assert(labels[3], toggled.length === 1, `rows updated = ${toggled.length} (expected 1)`);

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from accounts where name like 'rls shared toggle%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls shared toggle%' = ${probeCount}`,
  );
}

// `private.category_exists` answers whether an id is a category row at all, past row security, so a
// rule's guard can tell a deleted category from another person's. It returns a boolean and is callable
// by `authenticated` alone.
async function checkCategoryExistsProbe() {
  console.log("");
  const owner = randomUUID();
  const stranger = randomUUID();
  const forcedRollback = Symbol("forced rollback");

  const labels = [
    "329. the caller sees their own category and the probe says it exists",
    "330. another person's category is invisible to the caller yet the probe says it exists",
    "331. a deleted category reads as absent to the probe",
    "332. only authenticated may execute the probe, and it is a security definer with a fixed search_path",
    "334. a category of a group the caller is not in is invisible to the caller yet the probe says it exists",
  ];
  const tailLabel = "333. the rolled-back category-exists transaction leaves no trace";

  await sql
    .begin(async (tx) => {
      await tx`insert into auth.users (id) values (${owner}), (${stranger})`;
      await tx`insert into app_users (id) values (${owner}), (${stranger})`;

      await enterUserContext(tx, owner);
      const [{ id: own }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${owner}, 'rls category probe own', 'expense') returning id`;
      await tx`reset role`;
      await enterUserContext(tx, stranger);
      const [{ id: theirs }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${stranger}, 'rls category probe theirs', 'expense') returning id`;
      const [{ id: doomed }] = await tx<{ id: string }[]>`
        insert into categories (owner_user_id, name, kind)
        values (${stranger}, 'rls category probe doomed', 'expense') returning id`;
      await tx`delete from categories where id = ${doomed}`;

      await tx`reset role`;
      await enterUserContext(tx, owner);
      const [ownProbe] = await tx<{ seen: number; found: boolean }[]>`
        select (select count(*)::int from categories where id = ${own}) as seen,
          private.category_exists(${own}) as found`;
      assert(labels[0], ownProbe.seen === 1 && ownProbe.found === true, `seen = ${ownProbe.seen}, probe = ${ownProbe.found}`);

      const [theirProbe] = await tx<{ seen: number; found: boolean }[]>`
        select (select count(*)::int from categories where id = ${theirs}) as seen,
          private.category_exists(${theirs}) as found`;
      assert(
        labels[1],
        theirProbe.seen === 0 && theirProbe.found === true,
        `rows the caller sees = ${theirProbe.seen} (expected 0), probe = ${theirProbe.found} (expected true)`,
      );

      const [goneProbe] = await tx<{ found: boolean }[]>`select private.category_exists(${doomed}) as found`;
      assert(labels[2], goneProbe.found === false, `probe on a deleted id = ${goneProbe.found} (expected false)`);

      // A group-owned category has no owner_user_id: the probe must still see it.
      await tx`reset role`;
      await enterUserContext(tx, stranger);
      const foreignGroup = randomUUID();
      await tx`insert into groups (id, name, cash_mode) values (${foreignGroup}, 'rls category probe group', 'shared')`;
      await tx`insert into group_members (group_id, user_id, name, role)
        values (${foreignGroup}, ${stranger}, 'rls category probe leader', 'leader')`;
      const [{ id: groupCategory }] = await tx<{ id: string }[]>`
        insert into categories (group_id, name, kind)
        values (${foreignGroup}, 'rls category probe group category', 'expense') returning id`;
      await tx`reset role`;
      await enterUserContext(tx, owner);
      const [groupProbe] = await tx<{ seen: number; found: boolean }[]>`
        select (select count(*)::int from categories where id = ${groupCategory}) as seen,
          private.category_exists(${groupCategory}) as found`;
      assert(
        labels[4],
        groupProbe.seen === 0 && groupProbe.found === true,
        `rows the caller sees = ${groupProbe.seen} (expected 0), probe = ${groupProbe.found} (expected true)`,
      );

      await tx`reset role`;
      const [fn] = await tx<
        { anon: boolean; service: boolean; authenticated: boolean; definer: boolean; fixed_path: boolean }[]
      >`select
          has_function_privilege('anon', 'private.category_exists(uuid)', 'execute') as anon,
          has_function_privilege('service_role', 'private.category_exists(uuid)', 'execute') as service,
          has_function_privilege('authenticated', 'private.category_exists(uuid)', 'execute') as authenticated,
          p.prosecdef as definer,
          coalesce('search_path=""' = any (p.proconfig), false) as fixed_path
        from pg_proc p
        where p.oid = 'private.category_exists(uuid)'::regprocedure`;
      assert(
        labels[3],
        !fn.anon && !fn.service && fn.authenticated && fn.definer && fn.fixed_path,
        `execute anon=${fn.anon} service_role=${fn.service} authenticated=${fn.authenticated}, security definer = ${fn.definer}, search_path fixed = ${fn.fixed_path}`,
      );

      throw forcedRollback;
    })
    .catch((error: unknown) => {
      if (error !== forcedRollback) throw error;
    });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ count: probeCount }] = await sql<{ count: string }[]>`
    select count(*)::text as count from categories where name like 'rls category probe%'`;
  assert(
    tailLabel,
    afterUser === "postgres" && probeCount === "0",
    `current_user = ${afterUser}, rows named 'rls category probe%' = ${probeCount}`,
  );
}

// Assertions 335-351: migration 0058, HomeFund's list of invited addresses and the daily counter of
// sign-in links (RF-145, RF-143), the trigger that lists an address a leader invites, and the
// `allow-email` script. Every row runs in a transaction it rolls back, except the script rows, which
// write through a child process and remove what they wrote by exact address.
//
// Two hooks exist for proving a mutation red without touching the shared database:
//   M1_MIGRATION_FILE  a path to a SQL file; each row drops 0058's objects inside its own transaction
//                      and installs that file instead, so nothing outlives the ROLLBACK.
//   M1_ALLOW_EMAIL_SCRIPT / M1_LIST_URL  run another script, against another database, for the script rows.
const M1_ROLLBACK = Symbol("m1 rollback");
type M1Tx = postgres.TransactionSql;
type M1Verdict = { ok: boolean; detail: string };

function m1MigrationFile(): string {
  const dir = path.join(process.cwd(), "db", "migrations");
  const found = readdirSync(dir).find((name) => /^0058_.*\.sql$/.test(name));
  if (!found) throw new Error("db/migrations/0058_*.sql does not exist");
  return path.join(dir, found);
}

// Drops what 0058 made and runs its statements again, inside the caller's transaction. Postgres DDL
// is transactional, so the ROLLBACK puts the shared database back as it was.
async function m1Install(tx: M1Tx): Promise<void> {
  await tx.unsafe(`drop function if exists private.list_invited_email() cascade`);
  await tx.unsafe(`drop table if exists finances.allowed_emails, finances.sign_in_claims cascade`);
}

async function m1RunMigration(tx: M1Tx, file: string): Promise<void> {
  for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await tx.unsafe(statement);
  }
}

// Runs `body` in a transaction that always rolls back. A thrown error fails every label it owns.
async function m1Rows(
  labels: string[],
  body: (tx: M1Tx) => Promise<M1Verdict[]>,
  options: { reinstall?: boolean; beforeMigration?: (tx: M1Tx) => Promise<void> } = {},
): Promise<void> {
  let verdicts: M1Verdict[] = labels.map(() => ({ ok: false, detail: "the body never ran" }));
  await sql
    .begin(async (tx) => {
      const override = process.env.M1_MIGRATION_FILE;
      if (options.reinstall || override) {
        const file = override ?? m1MigrationFile();
        await m1Install(tx);
        if (options.beforeMigration) await options.beforeMigration(tx);
        await m1RunMigration(tx, file);
      }
      verdicts = await body(tx);
      throw M1_ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error === M1_ROLLBACK) return;
      verdicts = labels.map(() => ({ ok: false, detail: `aborted — ${describeRefusal(error)}` }));
    });
  labels.forEach((label, i) => assert(label, verdicts[i].ok, verdicts[i].detail));
}

// The sqlstate a statement is refused with, or null when it was accepted. A savepoint keeps the
// surrounding transaction usable.
async function m1Refusal(tx: M1Tx, run: (sp: M1Tx) => Promise<unknown>): Promise<string | null> {
  try {
    await tx.savepoint(async (sp) => {
      await run(sp as unknown as M1Tx);
    });
    return null;
  } catch (error) {
    return pgErrorCode(error) ?? "none";
  }
}

async function m1Become(tx: M1Tx, role: "authenticated" | "anon" | "service_role", subject: string) {
  const claims = JSON.stringify({ sub: subject, role, aud: role });
  await tx`select set_config('request.jwt.claims', ${claims}, true), set_config('role', ${role}, true)`;
}

// A group with a leader who has a login and a plain member who has one, seeded the way the
// member-management check does.
async function m1Group(tx: M1Tx) {
  const leader = randomUUID();
  const member = randomUUID();
  const groupId = randomUUID();
  await tx`insert into auth.users (id) values (${leader}), (${member})`;
  await tx`insert into app_users (id) values (${leader}), (${member})`;
  await enterUserContext(tx, leader);
  await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls m1', 'shared')`;
  await tx`insert into group_members (group_id, user_id, name, role)
    values (${groupId}, ${leader}, 'rls m1 leader', 'leader')`;
  await tx`reset role`;
  await tx`insert into group_members (group_id, user_id, name, role)
    values (${groupId}, ${member}, 'rls m1 member', 'member')`;
  return { leader, member, groupId };
}

async function m1Listed(tx: M1Tx, email: string): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from finances.allowed_emails where email = ${email}`;
  return n;
}

async function checkAllowedEmailList() {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const labels = {
    listClosed: "335. authenticated, anon and service_role read nothing from the allowed list; RLS on, no policy",
    claimsClosed: "336. the sign-in counter refuses select and insert to authenticated, anon and service_role",
    noGrant: "337. neither table carries a privilege of any kind for the three API roles",
    listShape: "338. the allowed list stores a folded address only, once",
    claimsShape: "339. the counter holds a count from 1 to 1000, once per client and day",
    seedUsers: "340. the seed lists every HomeFund user's address folded, and no harness .invalid address",
    seedInvites: "341. the seed lists a pending invitation and skips an archived one",
    leaderLists: "342. a leader's invitation lists the address folded; a row with no address lists nothing",
    leaderUpdates: "343. a leader setting an invite address lists it; renaming the row lists nothing",
    keepsRow: "344. an address already listed keeps its row when invited again",
    memberNothing: "345. a plain member's attempt to invite is refused and lists nothing",
    fnClosed: "346. only the trigger runs list_invited_email: a definer with a fixed search path, no caller may execute it",
    scriptOnce: "347. allow-email lists an address once, folded; a bad shape exits 1 and lists nothing",
    scriptCreates: "348. allow-email creates one confirmed Auth user, sends no mail, and creates none the second time",
    scriptRerun: "349. a failed Auth create leaves the address listed and a rerun completes it",
    scriptExisting: "350. allow-email leaves an Auth user that already exists as it is",
    tail: "351. the rolled-back allowed-list transactions leave no trace",
  };

  const ROLES = ["authenticated", "anon", "service_role"] as const;
  const TABLES = ["finances.allowed_emails", "finances.sign_in_claims"] as const;

  await m1Rows([labels.listClosed], async (tx) => {
    const [rel] = await tx<{ rls: boolean; policies: number }[]>`
      select c.relrowsecurity as rls,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c where c.oid = 'finances.allowed_emails'::regclass`;
    const verdict: string[] = [];
    let closed = true;
    for (const role of ROLES) {
      await m1Become(tx, role, randomUUID());
      const code = await m1Refusal(tx, (sp) => sp`select email from finances.allowed_emails`);
      await tx`reset role`;
      verdict.push(`${role} = ${code ?? "accepted"}`);
      if (code !== "42501") closed = false;
    }
    return [{ ok: closed && rel.rls === true && rel.policies === 0, detail: `${verdict.join(", ")}; RLS = ${rel.rls}, policies = ${rel.policies}` }];
  });

  await m1Rows([labels.claimsClosed], async (tx) => {
    const verdict: string[] = [];
    let closed = true;
    const [rel] = await tx<{ rls: boolean; policies: number }[]>`
      select c.relrowsecurity as rls,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c where c.oid = 'finances.sign_in_claims'::regclass`;
    for (const role of ROLES) {
      await m1Become(tx, role, randomUUID());
      const read = await m1Refusal(tx, (sp) => sp`select count from finances.sign_in_claims`);
      const write = await m1Refusal(
        tx,
        (sp) => sp`insert into finances.sign_in_claims (client_key, day, "count") values (${"k-" + tag}, current_date, 1)`,
      );
      await tx`reset role`;
      verdict.push(`${role}: select ${read ?? "accepted"}, insert ${write ?? "accepted"}`);
      if (read !== "42501" || write !== "42501") closed = false;
    }
    return [{ ok: closed && rel.rls === true && rel.policies === 0, detail: `${verdict.join("; ")}; RLS = ${rel.rls}, policies = ${rel.policies}` }];
  });

  await m1Rows([labels.noGrant], async (tx) => {
    const held: string[] = [];
    for (const table of TABLES) {
      for (const role of ROLES) {
        const [row] = await tx<{ any_table: boolean; any_column: boolean }[]>`
          select has_table_privilege(${role}, ${table}, 'select,insert,update,delete,truncate,references,trigger') as any_table,
            has_any_column_privilege(${role}, ${table}, 'select,insert,update,references') as any_column`;
        if (row.any_table || row.any_column) held.push(`${role} on ${table}`);
      }
    }
    return [{ ok: held.length === 0, detail: held.length === 0 ? "no privilege held" : `held: ${held.join(", ")}` }];
  });

  await m1Rows([labels.listShape], async (tx) => {
    const refused: Record<string, string | null> = {};
    for (const bad of [` Ana-${tag}@X.com `, `Ana-${tag}@x.com`, `no-at-sign-${tag}`, `@x-${tag}.com`]) {
      refused[bad] = await m1Refusal(tx, (sp) => sp`insert into finances.allowed_emails (email) values (${bad})`);
    }
    const good = `ana-${tag}@x.com`;
    const stored = await tx<{ added_at: Date | null }[]>`
      insert into finances.allowed_emails (email) values (${good}) returning added_at`;
    const twice = await m1Refusal(tx, (sp) => sp`insert into finances.allowed_emails (email) values (${good})`);
    const shapeOk = Object.values(refused).every((code) => code === "23514");
    return [
      {
        ok: shapeOk && stored[0]?.added_at != null && twice === "23505",
        detail: `unfolded or shapeless addresses refused = ${JSON.stringify(refused)}, folded address stored with added_at = ${stored[0]?.added_at ?? "none"}, second insert of it = ${twice ?? "accepted"}`,
      },
    ];
  });

  await m1Rows([labels.claimsShape], async (tx) => {
    const outcome: Record<string, string | null> = {};
    for (const n of [0, 1001, -1]) {
      outcome[`count ${n}`] = await m1Refusal(
        tx,
        (sp) => sp`insert into finances.sign_in_claims (client_key, day, "count") values (${"k-" + tag}, current_date, ${n})`,
      );
    }
    const edges = [1, 1000];
    const accepted: (string | null)[] = [];
    for (const n of edges) {
      accepted.push(
        await m1Refusal(
          tx,
          (sp) => sp`insert into finances.sign_in_claims (client_key, day, "count") values (${"edge-" + n + tag}, current_date, ${n})`,
        ),
      );
    }
    await tx`insert into finances.sign_in_claims (client_key, day, "count") values (${"dup-" + tag}, current_date, 1)`;
    const dup = await m1Refusal(
      tx,
      (sp) => sp`insert into finances.sign_in_claims (client_key, day, "count") values (${"dup-" + tag}, current_date, 2)`,
    );
    const otherDay = await m1Refusal(
      tx,
      (sp) => sp`insert into finances.sign_in_claims (client_key, day, "count") values (${"dup-" + tag}, current_date + 1, 1)`,
    );
    return [
      {
        ok:
          Object.values(outcome).every((code) => code === "23514") &&
          accepted.every((code) => code === null) &&
          dup === "23505" &&
          otherDay === null,
        detail: `out-of-range = ${JSON.stringify(outcome)}, edges 1 and 1000 = ${JSON.stringify(accepted)}, same client and day twice = ${dup ?? "accepted"}, same client next day = ${otherDay ?? "accepted"}`,
      },
    ];
  });

  // The seed: the migration is dropped and run again over fixtures planted first, inside one
  // rolled-back transaction, so what it listed is what a fresh migrate would list.
  const real = `Seed.Real.${tag}@Example.COM`;
  const realFolded = real.toLowerCase();
  const harnessAddress = `seed-${tag}@harness.invalid`;
  const noApp = `seed.noapp.${tag}@example.com`;
  const pending = `Seed.Pending.${tag}@Example.COM`;
  const archived = `seed.archived.${tag}@example.com`;
  const seedFixtures = async (tx: M1Tx) => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await tx`insert into auth.users (id, email) values (${a}, ${" " + real + " "}), (${b}, ${harnessAddress}), (${c}, ${noApp})`;
    await tx`insert into app_users (id) values (${a}), (${b})`;
    const group = await m1Group(tx);
    await enterUserContext(tx, group.leader);
    await tx`insert into group_members (group_id, name, role, invite_email)
      values (${group.groupId}, 'rls m1 pending', 'member', ${pending})`;
    await tx`insert into group_members (group_id, name, role, invite_email)
      values (${group.groupId}, 'rls m1 archived', 'member', ${archived})`;
    await tx`reset role`;
    await tx`update group_members set archived_at = now() where group_id = ${group.groupId} and invite_email = ${archived}`;
  };
  await m1Rows(
    [labels.seedUsers, labels.seedInvites],
    async (tx) => {
      const listedOf = async (email: string) => m1Listed(tx, email);
      const [missingUsers] = await tx<{ n: number }[]>`
        select count(*)::int as n
        from auth.users u join app_users a on a.id = u.id
        where u.email is not null
          and lower(btrim(u.email)) not like '%.invalid'
          and position('@' in lower(btrim(u.email))) > 1
          and not exists (select 1 from finances.allowed_emails e where e.email = lower(btrim(u.email)))`;
      const [strayInvalid] = await tx<{ n: number }[]>`
        select count(*)::int as n from finances.allowed_emails e
        where e.email like '%.invalid'
          and not exists (
            select 1 from finances.group_members m
            where lower(btrim(m.invite_email)) = e.email and m.user_id is null and m.archived_at is null)`;
      const users = {
        real: await listedOf(realFolded),
        harness: await listedOf(harnessAddress),
        noApp: await listedOf(noApp),
      };
      const invites = { pending: await listedOf(pending.toLowerCase()), archived: await listedOf(archived) };
      return [
        {
          ok: users.real === 1 && users.harness === 0 && users.noApp === 0 && missingUsers.n === 0 && strayInvalid.n === 0,
          detail: `user listed folded = ${users.real}, harness .invalid user = ${users.harness}, auth user with no app row = ${users.noApp}, app users missing from the list = ${missingUsers.n}, .invalid on the list with no pending invitation behind it = ${strayInvalid.n}`,
        },
        {
          ok: invites.pending === 1 && invites.archived === 0,
          detail: `pending invitation listed folded = ${invites.pending}, archived invitation listed = ${invites.archived}`,
        },
      ];
    },
    { reinstall: true, beforeMigration: seedFixtures },
  );

  await m1Rows([labels.leaderLists], async (tx) => {
    const group = await m1Group(tx);
    const invite = `Inv.${tag}@Y.invalid`;
    await enterUserContext(tx, group.leader);
    await tx`insert into group_members (group_id, name, role, invite_email)
      values (${group.groupId}, 'rls m1 invited', 'member', ${invite})`;
    await tx`reset role`;
    const [{ total: totalBefore }] = await tx<{ total: number }[]>`select count(*)::int as total from finances.allowed_emails`;
    await enterUserContext(tx, group.leader);
    await tx`insert into group_members (group_id, name, role) values (${group.groupId}, 'rls m1 no login', 'member')`;
    await tx`reset role`;
    const [{ total: totalAfter }] = await tx<{ total: number }[]>`select count(*)::int as total from finances.allowed_emails`;
    const folded = await m1Listed(tx, invite.toLowerCase());
    const raw = await m1Listed(tx, invite);
    return [
      {
        ok: folded === 1 && raw === 0 && totalAfter === totalBefore,
        detail: `listed folded = ${folded}, listed as typed = ${raw}, rows after an invitation with no address = ${totalAfter - totalBefore} new`,
      },
    ];
  });

  await m1Rows([labels.leaderUpdates], async (tx) => {
    const group = await m1Group(tx);
    const invite = `Upd.${tag}@Y.invalid`;
    await enterUserContext(tx, group.leader);
    const [{ id }] = await tx<{ id: string }[]>`
      insert into group_members (group_id, name, role) values (${group.groupId}, 'rls m1 later', 'member') returning id`;
    await tx`update group_members set invite_email = ${invite} where id = ${id}`;
    await tx`reset role`;
    const afterSet = await m1Listed(tx, invite.toLowerCase());
    // A revoked address stays revoked while the row is only renamed.
    await tx`delete from finances.allowed_emails where email = ${invite.toLowerCase()}`;
    await enterUserContext(tx, group.leader);
    await tx`update group_members set name = 'rls m1 renamed' where id = ${id}`;
    await tx`reset role`;
    const afterRename = await m1Listed(tx, invite.toLowerCase());
    return [
      {
        ok: afterSet === 1 && afterRename === 0,
        detail: `listed after setting the address = ${afterSet}, listed again after a rename alone = ${afterRename} (expected 0)`,
      },
    ];
  });

  await m1Rows([labels.keepsRow], async (tx) => {
    const group = await m1Group(tx);
    const address = `keep.${tag}@y.invalid`;
    await tx`insert into finances.allowed_emails (email, added_at) values (${address}, now() - interval '1 day')`;
    const [{ ts: before }] = await tx<{ ts: string }[]>`select added_at::text as ts from finances.allowed_emails where email = ${address}`;
    await enterUserContext(tx, group.leader);
    const code = await m1Refusal(
      tx,
      (sp) => sp`insert into group_members (group_id, name, role, invite_email)
        values (${group.groupId}, 'rls m1 again', 'member', ${address.toUpperCase()})`,
    );
    await tx`reset role`;
    const rows = await tx<{ ts: string }[]>`select added_at::text as ts from finances.allowed_emails where email = ${address}`;
    return [
      {
        ok: code === null && rows.length === 1 && rows[0].ts === before,
        detail: `invitation = ${code ?? "accepted"}, rows = ${rows.length}, added_at ${rows[0]?.ts} (was ${before})`,
      },
    ];
  });

  await m1Rows([labels.memberNothing], async (tx) => {
    const group = await m1Group(tx);
    const address = `mem.${tag}@y.invalid`;
    await enterUserContext(tx, group.member);
    const code = await m1Refusal(
      tx,
      (sp) => sp`insert into group_members (group_id, name, role, invite_email)
        values (${group.groupId}, 'rls m1 sneaky', 'member', ${address})`,
    );
    await tx`reset role`;
    const listed = await m1Listed(tx, address);
    return [
      {
        ok: code === "42501" && listed === 0,
        detail: `member's insert = ${code ?? "accepted"}, address listed = ${listed}`,
      },
    ];
  });

  await m1Rows([labels.fnClosed], async (tx) => {
    const [fn] = await tx<
      { anon: boolean; service: boolean; authenticated: boolean; definer: boolean; fixed_path: boolean; trig: number }[]
    >`select
        has_function_privilege('anon', 'private.list_invited_email()', 'execute') as anon,
        has_function_privilege('service_role', 'private.list_invited_email()', 'execute') as service,
        has_function_privilege('authenticated', 'private.list_invited_email()', 'execute') as authenticated,
        p.prosecdef as definer,
        coalesce('search_path=""' = any (p.proconfig), false) as fixed_path,
        (select count(*)::int from pg_trigger t
           where t.tgfoid = p.oid and t.tgrelid = 'finances.group_members'::regclass and not t.tgisinternal) as trig
      from pg_proc p where p.oid = 'private.list_invited_email()'::regprocedure`;
    await m1Become(tx, "authenticated", randomUUID());
    const code = await m1Refusal(tx, (sp) => sp`select private.list_invited_email()`);
    await tx`reset role`;
    return [
      {
        ok: !fn.anon && !fn.service && !fn.authenticated && fn.definer && fn.fixed_path && fn.trig === 1 && code === "42501",
        detail: `execute anon=${fn.anon} service_role=${fn.service} authenticated=${fn.authenticated}, definer = ${fn.definer}, search_path fixed = ${fn.fixed_path}, triggers on group_members = ${fn.trig}, direct call as authenticated = ${code ?? "accepted"}`,
      },
    ];
  });

  await m1ScriptRows(tag, labels);

  const [{ n: leftovers }] = await sql<{ n: number }[]>`
    select count(*)::int as n from finances.allowed_emails
    where email like ${"%" + tag + "%"}`.catch(() => [{ n: process.env.M1_MIGRATION_FILE ? 0 : -1 }]);
  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  assert(
    labels.tail,
    afterUser === "postgres" && leftovers === 0,
    `current_user = ${afterUser}, listed addresses carrying this run's tag = ${leftovers}`,
  );
}

type M1Labels = Record<string, string>;

function m1StackEnv(): Record<string, string> {
  const out = execFileSync("npx", ["--yes", "supabase@2.119.0", "status", "-o", "env"], {
    cwd: path.resolve(process.cwd(), "..", ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const values: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

async function m1Mail(mailpit: string, address: string): Promise<{ reachable: boolean; messages: number }> {
  try {
    const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    if (!response.ok) return { reachable: false, messages: -1 };
    const body = (await response.json()) as { messages_count?: number; total?: number };
    const count = body.messages_count ?? body.total;
    return typeof count === "number" ? { reachable: true, messages: count } : { reachable: false, messages: -1 };
  } catch {
    return { reachable: false, messages: -1 };
  }
}

// The script rows write for real, through a child process, against the local stack only. They
// remove by exact address and register every Auth user they cause in the harness registry.
async function m1ScriptRows(tag: string, labels: M1Labels) {
  const scriptLabels = [labels.scriptOnce, labels.scriptCreates, labels.scriptRerun, labels.scriptExisting];
  const fail = (detail: string) => scriptLabels.forEach((label) => assert(label, false, detail));

  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const listUrl = process.env.M1_LIST_URL ?? process.env.MIGRATION_DATABASE_URL ?? "";
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/;
  if (!local.test(apiUrl) || !/@(127\.0\.0\.1|localhost):/.test(listUrl) || !/@(127\.0\.0\.1|localhost):/.test(process.env.DATABASE_URL ?? "")) {
    fail(`refusing to run against anything but the local stack: API ${apiUrl || "unset"}`);
    return;
  }
  let stack: Record<string, string>;
  try {
    stack = m1StackEnv();
  } catch (error) {
    fail(`the local stack's keys could not be read — ${String(error)}`);
    return;
  }
  const serviceKey = stack.SERVICE_ROLE_KEY ?? "";
  const mailpit = stack.MAILPIT_URL ?? "http://127.0.0.1:44324";
  if (!serviceKey) {
    fail("the local stack reported no service-role key");
    return;
  }

  const listSql = postgres(listUrl, { prepare: false, max: 1 });
  const stamp = randomUUID().slice(0, 8);
  const addresses: string[] = [];
  const fresh = (): { typed: string; folded: string } => {
    const folded = `harness-allow-${stamp}-${addresses.length}@example.invalid`;
    addresses.push(folded);
    const typed = folded.replace("harness-allow", "Harness-Allow").replace("example", "Example");
    return { typed, folded };
  };

  const run = (address: string, key: string) => {
    const script = process.env.M1_ALLOW_EMAIL_SCRIPT;
    const [command, args] = script
      ? ["node", ["--import", "tsx", script, address]]
      : ["npm", ["run", "--silent", "allow-email", "--", address]];
    const result = spawnSync(command, args as string[], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: listUrl,
        NEXT_PUBLIC_SUPABASE_URL: apiUrl,
        SUPABASE_SERVICE_ROLE_KEY: key,
      },
    });
    return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  const authUsers = (address: string) =>
    sql<{ id: string; confirmed: boolean }[]>`
      select id, email_confirmed_at is not null as confirmed from auth.users where email = ${address}`;
  const listRows = (address: string) =>
    listSql<{ added_at: string }[]>`select added_at::text from finances.allowed_emails where email = ${address}`;
  const register = async (id: string, email: string) => {
    await sql`insert into harness.identities (user_id, run_id, email, disposition)
      values (${id}, ${runId()}, ${email}, 'ephemeral') on conflict (user_id) do nothing`;
  };

  try {
    // 347: once, folded, a bad shape refused.
    {
      const a = fresh();
      const first = run(a.typed, serviceKey);
      for (const user of await authUsers(a.folded)) await register(user.id, a.folded);
      const rowsAfterFirst = await listRows(a.folded).catch(() => []);
      const second = run(a.typed, serviceKey);
      const rowsAfterSecond = await listRows(a.folded).catch(() => []);
      // Counted under this run's stamp alone: another lane's invitations list addresses in the same table meanwhile.
      const countBefore = (await listSql<{ n: number }[]>`select count(*)::int as n from finances.allowed_emails where email like ${"%" + stamp + "%"}`.catch(() => [{ n: -1 }]))[0].n;
      // Queued for removal too: a script that skips the shape check lists the spaced one, and the CHECK admits it.
      const spacedAddress = `with space-${stamp}@example.invalid`;
      addresses.push(`not-an-address-${stamp}`, spacedAddress);
      const bad = run(`not-an-address-${stamp}`, serviceKey);
      const spaced = run(spacedAddress, serviceKey);
      const countAfter = (await listSql<{ n: number }[]>`select count(*)::int as n from finances.allowed_emails where email like ${"%" + stamp + "%"}`.catch(() => [{ n: -1 }]))[0].n;
      assert(
        labels.scriptOnce,
        first.code === 0 && /agregado/.test(first.out) && second.code === 0 && /ya estaba/.test(second.out) && !/agregado/.test(second.out) &&
          rowsAfterFirst.length === 1 && rowsAfterSecond.length === 1 && rowsAfterSecond[0].added_at === rowsAfterFirst[0].added_at &&
          bad.code === 1 && spaced.code === 1 && countBefore === countAfter && countBefore !== -1,
        `first run exit ${first.code} «${first.out.trim().split("\n").pop()}», second exit ${second.code} «${second.out.trim().split("\n").pop()}», rows ${rowsAfterFirst.length}/${rowsAfterSecond.length} under the folded address, bad shapes exit ${bad.code}/${spaced.code} with ${countAfter - countBefore} rows added`,
      );
    }

    // 348: one confirmed Auth user, no mail, none on the second run.
    {
      const a = fresh();
      const before = await m1Mail(mailpit, a.folded);
      const first = run(a.typed, serviceKey);
      const afterFirst = await authUsers(a.folded);
      for (const user of afterFirst) await register(user.id, a.folded);
      const mail = await m1Mail(mailpit, a.folded);
      const second = run(a.typed, serviceKey);
      const afterSecond = await authUsers(a.folded);
      assert(
        labels.scriptCreates,
        before.reachable && mail.reachable && first.code === 0 && second.code === 0 &&
          afterFirst.length === 1 && afterFirst[0].confirmed === true && mail.messages === 0 &&
          afterSecond.length === 1 && afterSecond[0].id === afterFirst[0]?.id,
        `exit ${first.code}/${second.code}, Auth users after run 1 = ${afterFirst.length} (confirmed = ${afterFirst[0]?.confirmed}), after run 2 = ${afterSecond.length}, messages for the address = ${mail.messages} (mailbox reachable = ${mail.reachable})`,
      );
    }

    // 349: a refused create leaves the address listed; the rerun completes it.
    {
      const a = fresh();
      const broken = run(a.typed, "not-a-real-key");
      const listedAfterBreak = await listRows(a.folded).catch(() => []);
      const usersAfterBreak = await authUsers(a.folded);
      for (const user of usersAfterBreak) await register(user.id, a.folded);
      const rerun = run(a.typed, serviceKey);
      const usersAfterRerun = await authUsers(a.folded);
      for (const user of usersAfterRerun) await register(user.id, a.folded);
      assert(
        labels.scriptRerun,
        broken.code !== 0 && broken.code !== null && listedAfterBreak.length === 1 && usersAfterBreak.length === 0 &&
          rerun.code === 0 && usersAfterRerun.length === 1 && usersAfterRerun[0].confirmed === true,
        `broken key exit ${broken.code}, listed = ${listedAfterBreak.length}, Auth users = ${usersAfterBreak.length}; rerun exit ${rerun.code}, Auth users = ${usersAfterRerun.length}`,
      );
    }

    // 350: an address that already has an Auth user keeps it untouched.
    {
      const a = fresh();
      // Made through the admin API, as a real invited person's row is: a bare insert into auth.users
      // leaves no identity row and GoTrue then refuses to create the address a second time.
      const made = await fetch(`${apiUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
        body: JSON.stringify({ email: a.folded, email_confirm: false }),
      });
      const existing = ((await made.json()) as { id?: string }).id ?? "";
      if (existing) await register(existing, a.folded);
      const result = run(a.typed, serviceKey);
      const users = await authUsers(a.folded);
      const listed = await listRows(a.folded).catch(() => []);
      assert(
        labels.scriptExisting,
        result.code === 0 && users.length === 1 && users[0].id === existing && users[0].confirmed === false && listed.length === 1,
        `exit ${result.code} «${result.out.trim().split("\n").slice(0, 2).join(" / ").slice(0, 160)}», Auth users = ${users.length}, same id = ${users[0]?.id === existing}, confirmed flipped = ${users[0]?.confirmed}, listed = ${listed.length}`,
      );
    }
  } finally {
    for (const address of addresses) {
      await listSql`delete from finances.allowed_emails where email = ${address}`.catch(() => undefined);
      const ids = (await authUsers(address)).map((user) => user.id);
      for (const id of ids) {
        await sql`delete from harness.identities where user_id = ${id}`.catch(() => undefined);
        await sql`delete from app_users where id = ${id}`.catch(() => undefined);
        await sql`delete from auth.users where id = ${id}`.catch(() => undefined);
      }
    }
    await listSql.end();
  }
}

// Assertions 352-357: the allowed list and the sign-in counter are audited like every other write
// (RF-43/44/45). Neither table has an `id`, so the record id is the primary key as text: the address,
// or `client_key/day`. Both rows are unscoped, so the viewer policy shows them to their actor alone.
// Every row runs in a transaction that rolls back, audit rows included: nothing remains afterwards.
// The seed is expected to be audited, so the triggers must exist before the migration's INSERT runs.
async function checkAllowedEmailAudit() {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const labels = {
    listed: "352. a leader's invitation writes one audit row for the listed address: folded record id, INSERT, the leader as actor, no scope",
    claim: "353. a counter row is audited with client_key/day as its record id: INSERT, UPDATE and DELETE, system actor, no scope",
    accounts: "354. an audited table with an id column still records the id as its record id",
    unreadable: "355. a plain member reads none of those audit rows; the leader who caused the listing reads only that one",
    seed: "356. the migration's own seed of the list is audited: one INSERT per address, folded record id, null actor, no scope",
    delRow: "357. removing a listed address writes a DELETE audit row with the address in before_data",
  };

  type Row = {
    entity: string;
    record_id: string;
    action: string;
    actor_user_id: string | null;
    owner_user_id: string | null;
    group_id: string | null;
    before_email: string | null;
  };
  const audit = (tx: M1Tx, entity: string, recordId: string) => tx<Row[]>`
    select entity, record_id, action, actor_user_id, owner_user_id, group_id, before_data->>'email' as before_email
    from finances.audit_log where entity = ${entity} and record_id = ${recordId} order by id`;

  await m1Rows([labels.listed, labels.delRow, labels.accounts], async (tx) => {
    const group = await m1Group(tx);
    const typed = `Inv.${tag}@Z.invalid`;
    const folded = typed.toLowerCase();
    await enterUserContext(tx, group.leader);
    await tx`insert into group_members (group_id, name, role, invite_email)
      values (${group.groupId}, 'rls m1b invited', 'member', ${typed})`;
    const [{ id: accountId }] = await tx<{ id: string }[]>`
      insert into accounts (owner_user_id, name, kind, initial_balance_on)
      values (${group.leader}, 'rls m1b account', 'asset', (now() at time zone 'America/Bogota')::date) returning id`;
    await tx`reset role`;
    const rows = await audit(tx, "allowed_emails", folded);
    const asTyped = await audit(tx, "allowed_emails", typed);
    const first = rows[0];

    await tx`select set_config('request.jwt.claims', '', true)`;
    await tx`delete from finances.allowed_emails where email = ${folded}`;
    const after = await audit(tx, "allowed_emails", folded);
    const gone = after.filter((r) => r.action === "DELETE");

    const acct = await audit(tx, "accounts", accountId);
    return [
      {
        ok:
          rows.length === 1 && asTyped.length === 0 &&
          first.action === "INSERT" && first.actor_user_id === group.leader &&
          first.owner_user_id === null && first.group_id === null,
        detail: `audit rows for the folded address = ${rows.length} (${rows.map((r) => r.action).join(",")}), keyed as typed = ${asTyped.length}, actor is the leader = ${first?.actor_user_id === group.leader}, owner = ${first?.owner_user_id ?? "null"}, group = ${first?.group_id ?? "null"}`,
      },
      {
        ok: gone.length === 1 && gone[0].before_email === folded && gone[0].owner_user_id === null && gone[0].group_id === null,
        detail: `DELETE rows = ${gone.length}, address in before_data = ${gone[0]?.before_email ?? "none"}`,
      },
      {
        ok: acct.length === 1 && acct[0].action === "INSERT" && acct[0].actor_user_id === group.leader && acct[0].owner_user_id === group.leader,
        detail: `audit rows keyed by the account id = ${acct.length}, owner scope kept = ${acct[0]?.owner_user_id === group.leader}`,
      },
    ];
  });

  await m1Rows([labels.claim], async (tx) => {
    const key = `m1b-${tag}`;
    const day = "2031-02-03";
    const recordId = `${key}/${day}`;
    // An earlier section settles a claim for the whole session; a system write must start with none.
    await tx`select set_config('request.jwt.claims', '', true)`;
    await tx`insert into finances.sign_in_claims (client_key, day, "count") values (${key}, ${day}, 1)`;
    await tx`insert into finances.sign_in_claims (client_key, day, "count") values (${key}, ${day}, 1)
      on conflict (client_key, day) do update set "count" = finances.sign_in_claims."count" + 1`;
    await tx`delete from finances.sign_in_claims where client_key = ${key} and day = ${day}`;
    const rows = await audit(tx, "sign_in_claims", recordId);
    const [{ n: elsewhere }] = await tx<{ n: number }[]>`
      select count(*)::int as n from finances.audit_log
      where entity = 'sign_in_claims' and record_id <> ${recordId}
        and coalesce(after_data->>'client_key', before_data->>'client_key') = ${key}`;
    const actions = rows.map((r) => r.action).join(",");
    return [
      {
        ok:
          actions === "INSERT,UPDATE,DELETE" && elsewhere === 0 &&
          rows.every((r) => r.actor_user_id === null && r.owner_user_id === null && r.group_id === null),
        detail: `rows keyed ${recordId} = ${actions || "none"}, rows for the key under another record id = ${elsewhere}`,
      },
    ];
  });

  await m1Rows([labels.unreadable], async (tx) => {
    const key = `m1b-read-${tag}`;
    await tx`select set_config('request.jwt.claims', '', true)`;
    await tx`insert into finances.sign_in_claims (client_key, day, "count") values (${key}, current_date, 1)`;
    const [{ d }] = await tx<{ d: string }[]>`select current_date::text as d`;
    const claimId = `${key}/${d}`;
    const group = await m1Group(tx);
    const typed = `Read.${tag}@Z.invalid`;
    await enterUserContext(tx, group.leader);
    await tx`insert into group_members (group_id, name, role, invite_email)
      values (${group.groupId}, 'rls m1b read', 'member', ${typed})`;
    await tx`reset role`;
    const count = async (who: string) => {
      await enterUserContext(tx, who);
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from finances.audit_log
        where (entity = 'allowed_emails' and record_id = ${typed.toLowerCase()})
           or (entity = 'sign_in_claims' and record_id = ${claimId})`;
      await tx`reset role`;
      return n;
    };
    const member = await count(group.member);
    const leader = await count(group.leader);
    return [
      { ok: member === 0 && leader === 1, detail: `rows the member reads = ${member} (expected 0), rows the leader reads = ${leader} (expected 1: the listing, not the counter)` },
    ];
  });

  const seedUser = `Seed.Audit.${tag}@Example.COM`;
  await m1Rows(
    [labels.seed],
    async (tx) => {
      const rows = await audit(tx, "allowed_emails", seedUser.toLowerCase());
      const typed = await audit(tx, "allowed_emails", seedUser);
      return [
        {
          ok:
            rows.length === 1 && typed.length === 0 && rows[0].action === "INSERT" &&
            rows[0].actor_user_id === null && rows[0].owner_user_id === null && rows[0].group_id === null,
          detail: `audit rows for the seeded address = ${rows.length}, keyed as typed = ${typed.length}, actor = ${rows[0]?.actor_user_id ?? "null"}`,
        },
      ];
    },
    {
      reinstall: true,
      beforeMigration: async (tx) => {
        await tx`select set_config('request.jwt.claims', '', true)`;
        const id = randomUUID();
        await tx`insert into auth.users (id, email) values (${id}, ${seedUser})`;
        await tx`insert into app_users (id) values (${id})`;
      },
    },
  );
}

// Assertions 358-366: migration 0059, the stored account subtypes `bank`, `cash`, `card` (RF-56). Each
// row replays 0059 over the state 0058 left, inside a transaction that rolls back: it restores the old
// CHECKs (NOT VALID), the old trigger function and the old default, seeds rows in the old words, and
// runs the migration's statements. The migration file is read by glob `0059_*.sql`;
// M11_MIGRATION_FILE points the same replay at another file, which is how a mutant is proved red
// without touching the shared database.
type M11Seed = { owner: string; bancaria: string; efectivo: string; tarjeta: string; cash: string; bank: string };

function m11MigrationFile(): string {
  const override = process.env.M11_MIGRATION_FILE;
  if (override) return override;
  const dir = path.join(process.cwd(), "db", "migrations");
  const found = readdirSync(dir).find((name) => /^0059_.*\.sql$/.test(name));
  if (!found) throw new Error("db/migrations/0059_*.sql does not exist");
  return path.join(dir, found);
}

async function m11Replay(tx: M1Tx, tag: string): Promise<M11Seed> {
  await tx`select set_config('request.jwt.claims', '', true)`;
  await tx.unsafe(`alter table finances.accounts drop constraint if exists accounts_subtype_kind`);
  await tx.unsafe(`alter table finances.accounts drop constraint if exists accounts_subtype_valid`);
  await tx.unsafe(`create or replace function private.set_account_subtype() returns trigger
    language plpgsql security definer set search_path = '' as $f$
    begin
      if new.subtype is distinct from 'efectivo' then
        new.subtype := case when new.kind = 'liability' then 'tarjeta' else 'bancaria' end;
      end if;
      return new;
    end; $f$`);
  // The state before 0059 let the function be called; the migration must close it.
  await tx.unsafe(
    `grant execute on function private.set_account_subtype() to public, anon, authenticated, service_role`,
  );
  await tx.unsafe(`alter table finances.accounts alter column subtype set default 'bancaria'`);

  const owner = randomUUID();
  await tx`insert into auth.users (id) values (${owner})`;
  await tx`insert into app_users (id) values (${owner})`;
  // The trigger would rewrite the explicit words; the rows stand as an old deploy left them.
  await tx.unsafe(`alter table finances.accounts disable trigger accounts_set_subtype`);
  const seed = async (suffix: string, kind: string, subtype: string): Promise<string> => {
    const [{ id }] = await tx<{ id: string }[]>`
      insert into finances.accounts (owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${owner}, ${`rls m11 ${suffix} ${tag}`}, ${kind}, ${subtype}, ${kind === "liability" ? -100 : 0},
        (now() at time zone 'America/Bogota')::date)
      returning id`;
    return id;
  };
  const bancaria = await seed("bancaria", "asset", "bancaria");
  const efectivo = await seed("efectivo", "asset", "efectivo");
  const tarjeta = await seed("tarjeta", "liability", "tarjeta");
  const cash = await seed("cash", "asset", "cash");
  const bank = await seed("bank", "asset", "bank");
  await tx.unsafe(`alter table finances.accounts enable trigger accounts_set_subtype`);
  await tx.unsafe(`alter table finances.accounts add constraint accounts_subtype_valid
    check (subtype in ('bancaria','efectivo','tarjeta')) not valid`);
  await tx.unsafe(`alter table finances.accounts add constraint accounts_subtype_kind
    check ((subtype in ('efectivo','bancaria') and kind = 'asset') or (subtype = 'tarjeta' and kind = 'liability')) not valid`);
  return { owner, bancaria, efectivo, tarjeta, cash, bank };
}

async function m11Rows(
  labels: string[],
  tag: string,
  body: (tx: M1Tx, seed: M11Seed) => Promise<M1Verdict[]>,
  afterMigration?: (tx: M1Tx) => Promise<void>,
): Promise<void> {
  let verdicts: M1Verdict[] = labels.map(() => ({ ok: false, detail: "the body never ran" }));
  await sql
    .begin(async (tx) => {
      const file = m11MigrationFile();
      const seed = await m11Replay(tx, tag);
      await m1RunMigration(tx, file);
      if (afterMigration) await afterMigration(tx);
      verdicts = await body(tx, seed);
      throw M1_ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error === M1_ROLLBACK) return;
      verdicts = labels.map(() => ({ ok: false, detail: `aborted — ${describeRefusal(error)}` }));
    });
  labels.forEach((label, i) => assert(label, verdicts[i].ok, verdicts[i].detail));
}

// The row's subtype after an authenticated insert, or `refused <sqlstate>`.
async function m11Insert(
  tx: M1Tx,
  owner: string,
  kind: "asset" | "liability",
  subtype: string | undefined,
  tag: string,
): Promise<string> {
  const name = `rls m11 ins ${randomUUID().slice(0, 6)} ${tag}`;
  const balance = kind === "liability" ? -100 : 0;
  await enterUserContext(tx, owner);
  try {
    return await tx.savepoint(async (sp) => {
      const rows =
        subtype === undefined
          ? await sp<{ subtype: string }[]>`
              insert into accounts (owner_user_id, name, kind, initial_balance_cents, initial_balance_on)
              values (${owner}, ${name}, ${kind}, ${balance}, (now() at time zone 'America/Bogota')::date)
              returning subtype`
          : await sp<{ subtype: string }[]>`
              insert into accounts (owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
              values (${owner}, ${name}, ${kind}, ${subtype}, ${balance}, (now() at time zone 'America/Bogota')::date)
              returning subtype`;
      return rows[0].subtype;
    });
  } catch (error) {
    return `refused ${pgErrorCode(error) ?? "none"}`;
  } finally {
    await tx`reset role`;
  }
}

// What an UPDATE of one account's subtype comes to: the sqlstate and the constraint named, or `landed`.
async function m11Update(tx: M1Tx, id: string, subtype: string, asUser?: string): Promise<string> {
  if (asUser) await enterUserContext(tx, asUser);
  try {
    return await tx.savepoint(async (sp) => {
      const done = await sp`update accounts set subtype = ${subtype} where id = ${id}`;
      return done.count === 1 ? "landed" : `matched ${done.count} rows`;
    });
  } catch (error) {
    const constraint = (error as { constraint_name?: string }).constraint_name ?? "?";
    return `refused ${pgErrorCode(error) ?? "none"} ${constraint}`;
  } finally {
    if (asUser) await tx`reset role`;
  }
}

async function checkAccountSubtypeWords() {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const labels = {
    maps: "358. 0059 maps bancaria to bank, efectivo to cash and tarjeta to card, leaves cash and bank rows as they were, and no other word remains",
    audited: "359. the mapping is audited: one UPDATE audit row per mapped account, old word before, new word after, null actor, the account's owner",
    refuseOld: "360. accounts_subtype_valid refuses bancaria, efectivo, tarjeta and an unknown word on an update",
    kind: "361. accounts_subtype_kind pins kind: a liability cannot be cash, an asset cannot be card, an asset moves from bank to cash",
    trigger: "362. the trigger keeps cash, stores efectivo as cash, derives every other word from kind and refuses cash on a liability",
    dflt: "363. the column default is bank",
    closed: "364. set_account_subtype is closed to anon, authenticated and service_role, a definer with a fixed search path",
    bodies: "365. no function body in private or finances names bancaria or tarjeta, and efectivo only set_account_subtype's",
    tail: "366. the rolled-back subtype replays leave no trace",
  };

  await m11Rows([labels.maps, labels.audited], tag, async (tx, seed) => {
    const read = async (id: string) =>
      (await tx<{ subtype: string }[]>`select subtype from finances.accounts where id = ${id}`)[0]?.subtype;
    const got = {
      bancaria: await read(seed.bancaria),
      efectivo: await read(seed.efectivo),
      tarjeta: await read(seed.tarjeta),
      cash: await read(seed.cash),
      bank: await read(seed.bank),
    };
    const [{ n: strays }] = await tx<{ n: number }[]>`
      select count(*)::int as n from finances.accounts where subtype not in ('bank', 'cash', 'card')`;
    type A = { record_id: string; before: string | null; after: string | null; actor: string | null; owner: string | null };
    const ids = [seed.bancaria, seed.efectivo, seed.tarjeta, seed.cash, seed.bank];
    const audit = await tx<A[]>`
      select record_id, before_data->>'subtype' as before, after_data->>'subtype' as after,
        actor_user_id as actor, owner_user_id as owner
      from finances.audit_log
      where entity = 'accounts' and action = 'UPDATE' and record_id = any(${ids}::text[])`;
    const expected: [string, string, string][] = [
      [seed.bancaria, "bancaria", "bank"],
      [seed.efectivo, "efectivo", "cash"],
      [seed.tarjeta, "tarjeta", "card"],
    ];
    const auditOk = expected.every(([id, before, after]) => {
      const rows = audit.filter((r) => r.record_id === id);
      return (
        rows.length === 1 && rows[0].before === before && rows[0].after === after && rows[0].actor === null && rows[0].owner === seed.owner
      );
    });
    return [
      {
        ok:
          got.bancaria === "bank" && got.efectivo === "cash" && got.tarjeta === "card" &&
          got.cash === "cash" && got.bank === "bank" && strays === 0,
        detail: `bancaria -> ${got.bancaria}, efectivo -> ${got.efectivo}, tarjeta -> ${got.tarjeta}, cash row ${got.cash}, bank row ${got.bank}, rows outside the three words = ${strays}`,
      },
      {
        ok: auditOk && audit.length === 3,
        detail: `UPDATE audit rows for the five seeded accounts = ${audit.length}; ${JSON.stringify(audit.map((r) => [r.before, r.after, r.actor, r.owner === seed.owner]))}`,
      },
    ];
  });

  // The kind CHECK is dropped after the replay so only accounts_subtype_valid can speak.
  await m11Rows(
    [labels.refuseOld],
    tag,
    async (tx, seed) => {
      const outcomes: string[] = [];
      for (const word of ["bancaria", "efectivo", "tarjeta", "banco"]) {
        outcomes.push(`${word}: ${await m11Update(tx, seed.bank, word)}`);
      }
      return [
        {
          ok: outcomes.every((o) => o.endsWith("refused 23514 accounts_subtype_valid")),
          detail: outcomes.join("; "),
        },
      ];
    },
    async (tx) => {
      await tx.unsafe(`alter table finances.accounts drop constraint if exists accounts_subtype_kind`);
    },
  );

  // The valid CHECK is dropped after the replay so only accounts_subtype_kind can speak.
  await m11Rows(
    [labels.kind],
    tag,
    async (tx, seed) => {
      const liabilityCash = await m11Update(tx, seed.tarjeta, "cash", seed.owner);
      const assetCard = await m11Update(tx, seed.bank, "card", seed.owner);
      const moved = await m11Update(tx, seed.bank, "cash", seed.owner);
      const [row] = await tx<{ subtype: string }[]>`select subtype from finances.accounts where id = ${seed.bank}`;
      return [
        {
          ok:
            liabilityCash === "refused 23514 accounts_subtype_kind" &&
            assetCard === "refused 23514 accounts_subtype_kind" &&
            moved === "landed" &&
            row.subtype === "cash",
          detail: `liability to cash: ${liabilityCash}; asset to card: ${assetCard}; asset bank to cash: ${moved}, now ${row.subtype}`,
        },
      ];
    },
    async (tx) => {
      await tx.unsafe(`alter table finances.accounts drop constraint if exists accounts_subtype_valid`);
    },
  );

  await m11Rows([labels.trigger], tag, async (tx, seed) => {
    const got = {
      assetCash: await m11Insert(tx, seed.owner, "asset", "cash", tag),
      assetEfectivo: await m11Insert(tx, seed.owner, "asset", "efectivo", tag),
      assetOmitted: await m11Insert(tx, seed.owner, "asset", undefined, tag),
      assetBank: await m11Insert(tx, seed.owner, "asset", "bank", tag),
      assetBancaria: await m11Insert(tx, seed.owner, "asset", "bancaria", tag),
      liabilityOmitted: await m11Insert(tx, seed.owner, "liability", undefined, tag),
      liabilityTarjeta: await m11Insert(tx, seed.owner, "liability", "tarjeta", tag),
      liabilityCash: await m11Insert(tx, seed.owner, "liability", "cash", tag),
    };
    const want = {
      assetCash: "cash",
      assetEfectivo: "cash",
      assetOmitted: "bank",
      assetBank: "bank",
      assetBancaria: "bank",
      liabilityOmitted: "card",
      liabilityTarjeta: "card",
      liabilityCash: "refused 23514",
    };
    return [{ ok: JSON.stringify(got) === JSON.stringify(want), detail: JSON.stringify(got) }];
  });

  await m11Rows([labels.dflt], tag, async (tx) => {
    const [row] = await tx<{ column_default: string | null }[]>`
      select column_default from information_schema.columns
      where table_schema = 'finances' and table_name = 'accounts' and column_name = 'subtype'`;
    return [{ ok: row?.column_default === "'bank'::text", detail: `column_default = ${row?.column_default}` }];
  });

  await m11Rows([labels.closed], tag, async (tx) => {
    const [fn] = await tx<
      { anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }[]
    >`
      select has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
        has_function_privilege('service_role', p.oid, 'execute') as service,
        p.prosecdef as definer, p.proconfig as config
      from pg_proc p where p.oid = 'private.set_account_subtype()'::regprocedure`;
    const fixedPath = (fn.config ?? []).some((entry) => entry === 'search_path=""');
    return [
      {
        ok: !fn.anon && !fn.authenticated && !fn.service && fn.definer && fixedPath,
        detail: `execute anon=${fn.anon} authenticated=${fn.authenticated} service_role=${fn.service}, definer = ${fn.definer}, proconfig = ${JSON.stringify(fn.config)}`,
      },
    ];
  });

  await m11Rows([labels.bodies], tag, async (tx) => {
    const rows = await tx<{ name: string; old: boolean; efectivo: boolean }[]>`
      select n.nspname || '.' || p.proname as name,
        p.prosrc ~ 'bancaria|tarjeta' as old, p.prosrc ~ 'efectivo' as efectivo
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('private', 'finances') and (p.prosrc ~ 'bancaria|tarjeta' or p.prosrc ~ 'efectivo')`;
    const oldNames = rows.filter((r) => r.old).map((r) => r.name);
    const efectivoNames = rows.filter((r) => r.efectivo).map((r) => r.name);
    return [
      {
        ok: oldNames.length === 0 && efectivoNames.length === 1 && efectivoNames[0] === "private.set_account_subtype",
        detail: `bodies naming bancaria or tarjeta = ${JSON.stringify(oldNames)}; bodies naming efectivo = ${JSON.stringify(efectivoNames)}`,
      },
    ];
  });

  const [{ n: leftovers }] = await sql<{ n: number }[]>`
    select count(*)::int as n from finances.accounts where name like ${"rls m11 % " + tag}`;
  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  assert(
    labels.tail,
    afterUser === "postgres" && leftovers === 0,
    `current_user = ${afterUser}, accounts carrying this run's tag = ${leftovers}`,
  );
}

// Assertions 367-379: migration 0060 (RF-150, RF-151). The leader of a fund asks the database whether
// an address already belongs to a live member of that fund, and an archived invitation stops
// holding the address. Every row replays the migration inside its own transaction and rolls back.
//
//   C6C_MIGRATION_FILE  a path to a SQL file installed instead of db/migrations/0060_*.sql, so a
//                       mutation can be proved red without touching the shared database.
async function c6cInstall(tx: M1Tx): Promise<void> {
  const override = process.env.C6C_MIGRATION_FILE;
  const dir = path.join(process.cwd(), "db", "migrations");
  const found = readdirSync(dir).find((name) => /^0060_.*\.sql$/.test(name));
  const file = override ?? (found ? path.join(dir, found) : null);
  if (!file) throw new Error("db/migrations/0060_*.sql does not exist");
  await tx.unsafe(`drop function if exists private.invite_email_is_member(text)`);
  for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await tx.unsafe(statement);
  }
}

async function c6cRows(labels: string[], body: (tx: M1Tx) => Promise<M1Verdict[]>): Promise<void> {
  await m1Rows(labels, body);
}

type C6cFund = {
  leader: string;
  member: string;
  archived: string;
  stranger: string;
  loner: string;
  leaderOfOther: string;
  groupId: string;
  otherGroupId: string;
  addr: Record<string, string>;
};

// A fund with a leader, a plain member and an archived member who each have a login, a pending
// invitation, and a second fund with its own leader and member. Stored addresses carry case and
// spaces on purpose; the people asked about are typed differently.
async function c6cFund(tx: M1Tx, tag: string): Promise<C6cFund> {
  const ids = { leader: randomUUID(), member: randomUUID(), archived: randomUUID(), stranger: randomUUID(), loner: randomUUID(), leaderOfOther: randomUUID() };
  const addr = {
    leader: `lead.${tag}@example.com`,
    member: `mem.${tag}@example.com`,
    archived: `gone.${tag}@example.com`,
    stranger: `other.${tag}@example.com`,
    loner: `loner.${tag}@example.com`,
    pending: `pend.${tag}@example.com`,
    unknown: `nobody.${tag}@example.com`,
  };
  await tx`insert into auth.users (id, email) values
    (${ids.leader}, ${addr.leader}),
    (${ids.member}, ${" Mem." + tag + "@Example.COM "}),
    (${ids.archived}, ${addr.archived}),
    (${ids.stranger}, ${addr.stranger}),
    (${ids.loner}, ${addr.loner}),
    (${ids.leaderOfOther}, ${"lead2." + tag + "@example.com"})`;
  await tx`insert into app_users (id) values (${ids.leader}), (${ids.member}), (${ids.archived}), (${ids.stranger}), (${ids.loner}), (${ids.leaderOfOther})`;
  const groupId = randomUUID();
  const otherGroupId = randomUUID();
  await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls c6c', 'shared'), (${otherGroupId}, 'rls c6c other', 'shared')`;
  await tx`insert into group_members (group_id, user_id, name, role) values
    (${groupId}, ${ids.leader}, 'rls c6c leader', 'leader'),
    (${groupId}, ${ids.member}, 'rls c6c member', 'member'),
    (${otherGroupId}, ${ids.leaderOfOther}, 'rls c6c other leader', 'leader'),
    (${otherGroupId}, ${ids.stranger}, 'rls c6c other member', 'member')`;
  await tx`insert into group_members (group_id, user_id, name, role, archived_at) values
    (${groupId}, ${ids.archived}, 'rls c6c archived', 'member', now())`;
  await tx`insert into group_members (group_id, name, role, invite_email) values
    (${groupId}, 'rls c6c pending', 'member', ${addr.pending})`;
  return { ...ids, groupId, otherGroupId, addr };
}

// What `private.invite_email_is_member` answers to a signed-in caller; a sqlstate when it refuses.
async function c6cAsk(tx: M1Tx, caller: string, email: string): Promise<boolean | string> {
  await enterUserContext(tx, caller);
  try {
    return await tx.savepoint(async (sp) => {
      const [{ r }] = await (sp as unknown as M1Tx)<{ r: boolean | null }[]>`select private.invite_email_is_member(${email}) as r`;
      return r as boolean;
    });
  } catch (error) {
    return pgErrorCode(error) ?? "none";
  } finally {
    await tx`reset role`;
  }
}

async function c6cRefusal(tx: M1Tx, run: (sp: M1Tx) => Promise<unknown>): Promise<{ code: string | null; constraint: string | null }> {
  try {
    await tx.savepoint(async (sp) => {
      await run(sp as unknown as M1Tx);
    });
    return { code: null, constraint: null };
  } catch (error) {
    return { code: pgErrorCode(error) ?? "none", constraint: (error as { constraint_name?: string }).constraint_name ?? null };
  }
}

async function checkMemberAddress() {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const labels = {
    found: "367. the leader learns that an address is a live member of the fund, however it is cased or spaced, and that an unknown one is not",
    own: "368. the leader's own address is a live member of the fund",
    pending: "369. a pending invitation's address is not a member",
    archived: "370. an archived member's address is not a live member",
    otherFund: "371. a live member of another fund is never looked at",
    memberCaller: "372. a plain member of the same fund learns nothing",
    noFund: "373. a caller with no fund, and a leader whose own row is archived, learn nothing",
    grants: "374. the function is a stable definer with a fixed search path; authenticated may execute it, anon, service_role and PUBLIC may not",
    unauthenticated: "375. anon and service_role are refused when they call it",
    archivedFree: "376. an archived pending invitation no longer holds its address; a new one lands and the archived row is untouched",
    twoLive: "377. a second live pending invitation to the same address is still refused, in any case, and another fund may hold it",
    restore: "378. restoring the archived invitation while a live one holds the address is a 23505 on group_members_group_invite_email_unique",
    claim: "379. signing in with an archived and a live invitation to the address claims neither (RF-154)",
    live: "380. the live database carries the function and the narrowed index",
  };

  await c6cRows([labels.found], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const lower = await c6cAsk(tx, f.leader, f.addr.member);
    const shouted = await c6cAsk(tx, f.leader, `  MEM.${tag.toUpperCase()}@EXAMPLE.COM `);
    const unknown = await c6cAsk(tx, f.leader, f.addr.unknown);
    return [{ ok: lower === true && shouted === true && unknown === false, detail: `lower-case ask = ${lower}, shouted and spaced ask = ${shouted}, unknown address = ${unknown}` }];
  });

  await c6cRows([labels.own], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const own = await c6cAsk(tx, f.leader, `  ${f.addr.leader.toUpperCase()} `);
    return [{ ok: own === true, detail: `the leader's own address = ${own}` }];
  });

  await c6cRows([labels.pending], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const pending = await c6cAsk(tx, f.leader, f.addr.pending);
    const folded = await c6cAsk(tx, f.leader, f.addr.pending.toUpperCase());
    return [{ ok: pending === false && folded === false, detail: `pending address = ${pending}, folded = ${folded}` }];
  });

  await c6cRows([labels.archived], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const archived = await c6cAsk(tx, f.leader, f.addr.archived);
    return [{ ok: archived === false, detail: `archived member's address = ${archived}` }];
  });

  await c6cRows([labels.otherFund], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const other = await c6cAsk(tx, f.leader, f.addr.stranger);
    const reverse = await c6cAsk(tx, f.leaderOfOther, f.addr.member);
    return [{ ok: other === false && reverse === false, detail: `another fund's member asked by this leader = ${other}, this fund's member asked by the other leader = ${reverse}` }];
  });

  await c6cRows([labels.memberCaller], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const asMember = await c6cAsk(tx, f.member, f.addr.leader);
    const ownAddress = await c6cAsk(tx, f.member, f.addr.member);
    return [{ ok: asMember === false && ownAddress === false, detail: `plain member asks about the leader = ${asMember}, about itself = ${ownAddress}` }];
  });

  await c6cRows([labels.noFund], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const loner = await c6cAsk(tx, f.loner, f.addr.leader);
    const aboutSelf = await c6cAsk(tx, f.loner, f.addr.loner);
    await tx`update group_members set archived_at = now() where group_id = ${f.groupId} and user_id = ${f.leader}`;
    const demoted = await c6cAsk(tx, f.leader, f.addr.member);
    return [{ ok: loner === false && aboutSelf === false && demoted === false, detail: `no fund asks = ${loner}, asks about itself = ${aboutSelf}, archived leader asks = ${demoted}` }];
  });

  await c6cRows([labels.grants], async (tx) => {
    await c6cInstall(tx);
    const [fn] = await tx<{ definer: boolean; stable: boolean; fixed_path: boolean; returns: string }[]>`
      select p.prosecdef as definer, p.provolatile = 's' as stable,
        coalesce('search_path=""' = any (p.proconfig), false) as fixed_path,
        p.prorettype::regtype::text as returns
      from pg_proc p where p.oid = 'private.invite_email_is_member(text)'::regprocedure`;
    const [acl] = await tx<{ authenticated: boolean; anon: boolean; service: boolean; pub: boolean }[]>`
      select has_function_privilege('authenticated', 'private.invite_email_is_member(text)', 'execute') as authenticated,
        has_function_privilege('anon', 'private.invite_email_is_member(text)', 'execute') as anon,
        has_function_privilege('service_role', 'private.invite_email_is_member(text)', 'execute') as service,
        has_function_privilege(0, 'private.invite_email_is_member(text)', 'execute') as pub`;
    const routine = await tx<{ grantee: string }[]>`
      select grantee from information_schema.routine_privileges
      where routine_schema = 'private' and routine_name = 'invite_email_is_member' and privilege_type = 'EXECUTE'
        and grantee in ('authenticated', 'anon', 'service_role', 'PUBLIC')`;
    const grantees = routine.map((r) => r.grantee).sort();
    return [
      {
        ok: fn.definer && fn.stable && fn.fixed_path && fn.returns === "boolean" && acl.authenticated && !acl.anon && !acl.service && !acl.pub && grantees.length === 1 && grantees[0] === "authenticated",
        detail: `definer = ${fn.definer}, stable = ${fn.stable}, search_path fixed = ${fn.fixed_path}, returns ${fn.returns}; execute authenticated = ${acl.authenticated}, anon = ${acl.anon}, service_role = ${acl.service}, PUBLIC = ${acl.pub}; routine_privileges grantees = ${JSON.stringify(grantees)}`,
      },
    ];
  });

  await c6cRows([labels.unauthenticated], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const verdict: string[] = [];
    let closed = true;
    for (const role of ["anon", "service_role"] as const) {
      await m1Become(tx, role, f.leader);
      const code = await m1Refusal(tx, (sp) => sp`select private.invite_email_is_member(${f.addr.member})`);
      await tx`reset role`;
      verdict.push(`${role} = ${code ?? "accepted"}`);
      if (code !== "42501") closed = false;
    }
    return [{ ok: closed, detail: verdict.join(", ") }];
  });

  await c6cRows([labels.archivedFree], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const x = f.addr.pending;
    await tx`update group_members set archived_at = now() - interval '1 day' where group_id = ${f.groupId} and invite_email = ${x}`;
    const [before] = await tx<{ id: string; archived_at: string; invite_email: string }[]>`
      select id, archived_at::text, invite_email from group_members where group_id = ${f.groupId} and invite_email = ${x}`;
    await enterUserContext(tx, f.leader);
    const again = await c6cRefusal(tx, (sp) => sp`insert into group_members (group_id, name, role, invite_email)
      values (${f.groupId}, 'rls c6c reinvited', 'member', ${x.toUpperCase()})`);
    await tx`reset role`;
    const rows = await tx<{ id: string; archived_at: string | null; invite_email: string }[]>`
      select id, archived_at::text, invite_email from group_members
      where group_id = ${f.groupId} and lower(invite_email) = ${x} order by created_at, id`;
    const live = rows.filter((r) => r.archived_at === null);
    const old = rows.find((r) => r.id === before.id);
    return [
      {
        ok: again.code === null && rows.length === 2 && live.length === 1 && old?.archived_at === before.archived_at && old?.invite_email === before.invite_email,
        detail: `second invitation = ${again.code ?? "accepted"}, rows = ${rows.length}, live = ${live.length}, archived row unchanged = ${old?.archived_at === before.archived_at}`,
      },
    ];
  });

  await c6cRows([labels.twoLive], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    await enterUserContext(tx, f.leader);
    const same = await c6cRefusal(tx, (sp) => sp`insert into group_members (group_id, name, role, invite_email)
      values (${f.groupId}, 'rls c6c twice', 'member', ${f.addr.pending})`);
    const folded = await c6cRefusal(tx, (sp) => sp`insert into group_members (group_id, name, role, invite_email)
      values (${f.groupId}, 'rls c6c twice folded', 'member', ${f.addr.pending.toUpperCase()})`);
    await tx`reset role`;
    await enterUserContext(tx, f.leaderOfOther);
    const elsewhere = await c6cRefusal(tx, (sp) => sp`insert into group_members (group_id, name, role, invite_email)
      values (${f.otherGroupId}, 'rls c6c elsewhere', 'member', ${f.addr.pending})`);
    await tx`reset role`;
    return [
      {
        ok: same.code === "23505" && folded.code === "23505" && same.constraint === "group_members_group_invite_email_unique" && elsewhere.code === null,
        detail: `same address = ${same.code ?? "accepted"} (${same.constraint}), other case = ${folded.code ?? "accepted"}, another fund = ${elsewhere.code ?? "accepted"}`,
      },
    ];
  });

  await c6cRows([labels.restore], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const x = f.addr.pending;
    await tx`update group_members set archived_at = now() where group_id = ${f.groupId} and invite_email = ${x}`;
    await tx`insert into group_members (group_id, name, role, invite_email) values (${f.groupId}, 'rls c6c live twin', 'member', ${x})`;
    await enterUserContext(tx, f.leader);
    const restored = await c6cRefusal(tx, (sp) => sp`
      update group_members set archived_at = null where group_id = ${f.groupId} and invite_email = ${x} and archived_at is not null`);
    await tx`reset role`;
    return [
      {
        ok: restored.code === "23505" && restored.constraint === "group_members_group_invite_email_unique",
        detail: `restore = ${restored.code ?? "accepted"} on ${restored.constraint}`,
      },
    ];
  });

  await c6cRows([labels.claim], async (tx) => {
    await c6cInstall(tx);
    const f = await c6cFund(tx, tag);
    const x = `claim.${tag}@example.com`;
    const claimer = randomUUID();
    await tx`insert into auth.users (id, email) values (${claimer}, ${x})`;
    await tx`insert into app_users (id) values (${claimer})`;
    const [dead] = await tx<{ id: string }[]>`
      insert into group_members (group_id, name, role, invite_email, archived_at)
      values (${f.groupId}, 'rls c6c old invitation', 'member', ${x}, now() - interval '2 days') returning id`;
    const [live] = await tx<{ id: string }[]>`
      insert into group_members (group_id, name, role, invite_email) values (${f.groupId}, 'rls c6c new invitation', 'member', ${x}) returning id`;
    await enterUserContext(tx, claimer, x);
    const [{ id }] = await tx<{ id: string | null }[]>`select private.claim_group_invite() as id`;
    await tx`reset role`;
    const rows = await tx<{ id: string; user_id: string | null }[]>`select id, user_id from group_members where id in (${dead.id}, ${live.id})`;
    const claimedLive = rows.find((r) => r.id === live.id)?.user_id === claimer;
    const deadUntouched = rows.find((r) => r.id === dead.id)?.user_id === null;
    const liveUntouched = rows.find((r) => r.id === live.id)?.user_id === null;
    return [
      {
        ok: id === null && !claimedLive && liveUntouched && deadUntouched,
        detail: `claim returned ${id ?? "null"}, live row holds the user = ${claimedLive}, live row untouched = ${liveUntouched}, archived row untouched = ${deadUntouched}`,
      },
    ];
  });

  // No replay here: the database the app runs against must itself carry the migration.
  const [state] = await sql<{ fn: string | null; def: string | null }[]>`
    select to_regprocedure('private.invite_email_is_member(text)')::text as fn,
      (select indexdef from pg_indexes where schemaname = 'finances' and indexname = 'group_members_group_invite_email_unique') as def`;
  const def = (state.def ?? "").toLowerCase();
  assert(
    labels.live,
    state.fn !== null && def.includes("archived_at is null") && def.includes("invite_email is not null") && def.includes("unique"),
    `function = ${state.fn ?? "absent"}, index = ${state.def ?? "absent"}`,
  );
}

// Assertions 389-394: why a rule is paused (M49). `paused_reason` is the run's to write: the app
// reads it and its person cannot forge it, on insert or update; the column admits only 'failed'; the
// run writes it when a rule's generation raises and writes nothing for a rule that merely ended.
// The run is scoped to the fixture's own user, so no other tenant's due rule is touched.
async function checkRecurringPauseReason() {
  console.log("");
  const labels = {
    updateBarred: "389. authenticated cannot update paused_reason on its own rule (42501)",
    insertBarred: "390. authenticated cannot insert a rule carrying a paused_reason (42501)",
    check: "391. paused_reason admits null and 'failed' and refuses any other value (23514)",
    written: "392. a rule whose generation raises is paused with paused_reason 'failed'",
    ended: "393. a rule that ran its course (ends_on) is inactive with no paused_reason",
    healthy: "394. a rule that books cleanly stays active with no paused_reason",
  };
  const today = `(now() at time zone 'America/Bogota')::date`;

  await m1Rows(Object.values(labels), async (tx) => {
    const userA = randomUUID();
    const userB = randomUUID();
    await tx`insert into auth.users (id) values (${userA}), (${userB})`;
    await tx`insert into app_users (id) values (${userA}), (${userB})`;

    await enterUserContext(tx, userA);
    const [{ id: accountA }] = await tx<{ id: string }[]>`
      insert into accounts (owner_user_id, name, kind, initial_balance_on)
      values (${userA}, 'rls pause reason a cash', 'asset', ${tx.unsafe(today)}) returning id`;
    const [{ id: catA }] = await tx<{ id: string }[]>`
      insert into categories (owner_user_id, name, kind)
      values (${userA}, 'rls pause reason a expense', 'expense') returning id`;
    const [{ id: healthy }] = await tx<{ id: string }[]>`
      insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on)
      values (${accountA}, 1000, ${catA}, 'weekly', 1, ${tx.unsafe(today)}) returning id`;
    const [{ id: ended }] = await tx<{ id: string }[]>`
      insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on, ends_on)
      values (${accountA}, 1000, ${catA}, 'weekly', 1, ${tx.unsafe(today)}, ${tx.unsafe(today)}) returning id`;
    const updateCode = await m1Refusal(tx, (sp) =>
      sp`update recurring_rules set paused_reason = 'failed' where id = ${healthy}`);
    const insertCode = await m1Refusal(tx, (sp) =>
      sp`insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on, paused_reason)
         values (${accountA}, 1000, ${catA}, 'weekly', 1, ${tx.unsafe(today)}, 'failed')`);

    await tx`reset role`;
    const refusedValue = await m1Refusal(tx, (sp) =>
      sp`update recurring_rules set paused_reason = 'bogus' where id = ${healthy}`);
    const failedAccepted = await m1Refusal(tx, (sp) =>
      sp`update recurring_rules set paused_reason = 'failed' where id = ${healthy}`);
    const nullAccepted = await m1Refusal(tx, (sp) =>
      sp`update recurring_rules set paused_reason = null where id = ${healthy}`);

    await enterUserContext(tx, userB);
    const [{ id: accountB }] = await tx<{ id: string }[]>`
      insert into accounts (owner_user_id, name, kind, initial_balance_on)
      values (${userB}, 'rls pause reason b cash', 'asset', ${tx.unsafe(today)}) returning id`;
    // B's rule names A's category: another scope, which the split trigger refuses on generation.
    const [{ id: bad }] = await tx<{ id: string }[]>`
      insert into recurring_rules (from_account_id, amount_cents, category_id, frequency, interval_n, next_run_on)
      values (${accountB}, 1000, ${catA}, 'weekly', 1, ${tx.unsafe(today)}) returning id`;
    await tx`reset role`;
    await tx`select set_config('request.jwt.claims', '', true)`;
    await tx`select private.run_due_recurring_rules(${userA}::uuid)`;
    await tx`select private.run_due_recurring_rules(${userB}::uuid)`;
    await tx`set constraints all immediate`;

    const state = async (id: string) =>
      (await tx<{ is_active: boolean; paused_reason: string | null }[]>`
        select is_active, paused_reason from recurring_rules where id = ${id}`)[0];
    const badState = await state(bad);
    const endedState = await state(ended);
    const healthyState = await state(healthy);

    return [
      { ok: updateCode === "42501", detail: `update answered ${updateCode}` },
      { ok: insertCode === "42501", detail: `insert answered ${insertCode}` },
      {
        ok: refusedValue === "23514" && failedAccepted === null && nullAccepted === null,
        detail: `'bogus' -> ${refusedValue}, 'failed' -> ${failedAccepted ?? "accepted"}, null -> ${nullAccepted ?? "accepted"}`,
      },
      {
        ok: badState.is_active === false && badState.paused_reason === "failed",
        detail: `is_active = ${badState.is_active}, paused_reason = ${badState.paused_reason}`,
      },
      {
        ok: endedState.is_active === false && endedState.paused_reason === null,
        detail: `is_active = ${endedState.is_active}, paused_reason = ${endedState.paused_reason}`,
      },
      {
        ok: healthyState.is_active === true && healthyState.paused_reason === null,
        detail: `is_active = ${healthyState.is_active}, paused_reason = ${healthyState.paused_reason}`,
      },
    ];
  });
}

// Assertions 395-406: an invitation is accepted, never claimed (RF-154, migration 0064). The contract the
// rows are written from, in the choices the schema left open (each one is the most natural reading):
//   - `group_members.invite_state` is text, 'pending' | 'accepted' | 'declined', not null.
//   - A row the leader inserts with an `invite_email`, exactly as the app does today, reads 'pending'.
//   - A pending row has no `user_id`; an accepted row has one and no `invite_email`; a declined row is archived.
//   - Accepting and declining are written by the server (the definer functions of M68), never by a caller's
//     own UPDATE: the rows here write them as the owner, after `reset role`.
//   - Signing in (`private.claim_group_invite()`, today's claim) joins nobody.
// The sign-in path is driven in every setup as today's "claimed" contrast; the rows say what it must leave.
//
//   D64_MIGRATION_FILE  a path to a SQL file installed instead of db/migrations/0064_*.sql, so a mutation
//                       can be proved red without touching the shared database. Replayed inside the
//                       row's transaction only when the live database does not carry the column yet.
async function d64Install(tx: M1Tx): Promise<void> {
  const [{ has }] = await tx<{ has: boolean }[]>`
    select exists (select 1 from information_schema.columns
      where table_schema = 'finances' and table_name = 'group_members' and column_name = 'invite_state') as has`;
  if (has) return;
  const dir = path.join(process.cwd(), "db", "migrations");
  const found = readdirSync(dir).find((name) => /^0064_.*\.sql$/.test(name));
  const file = process.env.D64_MIGRATION_FILE ?? (found ? path.join(dir, found) : null);
  if (!file) return;
  for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await tx.unsafe(statement);
  }
}

type D64Fund = {
  leader: string;
  invitee: string;
  groupId: string;
  rowId: string;
  email: string;
  accounts: number;
  movements: number;
  categories: number;
};

// A fund with its leader, and a person with a book of their own (two personal accounts, one movement
// between them, one category) whom the leader invites by address.
async function d64Fund(tx: M1Tx): Promise<D64Fund> {
  await d64Install(tx);
  const leader = randomUUID();
  const invitee = randomUUID();
  const groupId = randomUUID();
  const email = `d64-${randomUUID()}@example.test`;
  const today = `(now() at time zone 'America/Bogota')::date`;
  await tx`insert into auth.users (id) values (${leader}), (${invitee})`;
  await tx`insert into app_users (id) values (${leader}), (${invitee})`;

  await enterUserContext(tx, invitee, email);
  const [{ id: a }] = await tx<{ id: string }[]>`
    insert into accounts (owner_user_id, name, kind, initial_balance_on)
    values (${invitee}, 'rls d64 own a', 'asset', ${tx.unsafe(today)}) returning id`;
  const [{ id: b }] = await tx<{ id: string }[]>`
    insert into accounts (owner_user_id, name, kind, initial_balance_on)
    values (${invitee}, 'rls d64 own b', 'asset', ${tx.unsafe(today)}) returning id`;
  await tx`insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
    values (${a}, ${b}, 1500, ${tx.unsafe(today)})`;
  await tx`insert into categories (owner_user_id, name, kind) values (${invitee}, 'rls d64 own category', 'expense')`;
  await tx`reset role`;

  await enterUserContext(tx, leader);
  await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls d64', 'shared')`;
  await tx`insert into group_members (group_id, user_id, name, role) values (${groupId}, ${leader}, 'rls d64 leader', 'leader')`;
  // The app's own insert: no state named. The database says what an address-bearing row is.
  const [{ id: rowId }] = await tx<{ id: string }[]>`
    insert into group_members (group_id, name, role, invite_email)
    values (${groupId}, 'rls d64 invited', 'member', ${email}) returning id`;
  await tx`reset role`;
  return { leader, invitee, groupId, rowId, email, accounts: 2, movements: 1, categories: 1 };
}

// What the leader reads of the invitee's personal book.
async function d64LeaderReads(tx: M1Tx, f: D64Fund): Promise<{ accounts: number; movements: number; categories: number }> {
  await enterUserContext(tx, f.leader);
  try {
    const [{ n: accounts }] = await tx<{ n: number }[]>`
      select count(*)::int as n from accounts where owner_user_id = ${f.invitee}`;
    const [{ n: movements }] = await tx<{ n: number }[]>`
      select count(*)::int as n from transactions where owner_user_id = ${f.invitee}`;
    const [{ n: categories }] = await tx<{ n: number }[]>`
      select count(*)::int as n from categories where owner_user_id = ${f.invitee}`;
    return { accounts, movements, categories };
  } finally {
    await tx`reset role`;
  }
}

// Today's sign-in: the invitee's session calls the claim. Returns what it answered, or its sqlstate.
async function d64SignIn(tx: M1Tx, f: D64Fund): Promise<string> {
  await enterUserContext(tx, f.invitee, f.email);
  try {
    return await tx.savepoint(async (sp) => {
      const [{ id }] = await (sp as unknown as M1Tx)<{ id: string | null }[]>`select private.claim_group_invite() as id`;
      return id ? "joined" : "nothing";
    });
  } catch (error) {
    return `refused ${pgErrorCode(error) ?? "none"}`;
  } finally {
    await tx`reset role`;
  }
}

async function d64Row(tx: M1Tx, id: string) {
  const [row] = await tx<{ user_id: string | null; invite_email: string | null; invite_state: string; archived: boolean }[]>`
    select user_id, invite_email, invite_state, archived_at is not null as archived from group_members where id = ${id}`;
  return row;
}

async function d64Accept(tx: M1Tx, f: D64Fund): Promise<void> {
  await tx`update group_members set user_id = ${f.invitee}, invite_email = null, invite_state = 'accepted' where id = ${f.rowId}`;
}

async function d64Decline(tx: M1Tx, f: D64Fund): Promise<void> {
  await tx`update group_members set invite_state = 'declined', archived_at = now() where id = ${f.rowId}`;
}

async function checkInvitationAcceptance() {
  console.log("");
  const labels = {
    accounts: "395. a leader who invited an address reads none of that person's personal accounts, even after they sign in",
    movements: "396. a leader who invited an address reads none of that person's personal movements, even after they sign in",
    categories: "397. a leader who invited an address reads none of that person's personal categories, even after they sign in",
    stays: "398. signing in leaves the invitation pending: no user_id, the address kept, the person in no fund",
    pending: "399. an invitation the leader inserts reads 'pending', and a pending row refuses a user_id (23514)",
    valid: "400. only pending, accepted and declined are storable; any other state is a 23514",
    declinedArchived: "401. a declined invitation that is not archived is a 23514, so a decline always frees the address",
    declined: "402. after a decline the leader still reads none of the person's book, and signing in again joins nobody",
    reinvite: "403. a declined address can be invited again, in any case; a second live invitation to it is still a 23505; signing in joins nobody",
    accepted: "404. an accepted invitation (state 'accepted', user_id set) reads what membership reads: the person's whole book",
    grants: "405. no caller may write invite_state: authenticated, anon and service_role hold no INSERT or UPDATE on it, and a leader's UPDATE is a 42501",
    liveAfter: "406. an accepted person who was once pending holds no invite_email and keeps the one-group index (a second live row for them is a 23505)",
  };

  // The three personal books, read after the claim path ran: the only thing the sign-in may not do is open them.
  await m1Rows([labels.accounts, labels.movements, labels.categories], async (tx) => {
    const f = await d64Fund(tx);
    const before = await d64LeaderReads(tx, f);
    const signIn = await d64SignIn(tx, f);
    const after = await d64LeaderReads(tx, f);
    return [
      { ok: before.accounts === 0 && after.accounts === 0, detail: `accounts before sign-in = ${before.accounts}, after = ${after.accounts} (sign-in ${signIn})` },
      { ok: before.movements === 0 && after.movements === 0, detail: `movements before sign-in = ${before.movements}, after = ${after.movements} (sign-in ${signIn})` },
      { ok: before.categories === 0 && after.categories === 0, detail: `categories before sign-in = ${before.categories}, after = ${after.categories} (sign-in ${signIn})` },
    ];
  });

  await m1Rows([labels.stays], async (tx) => {
    const f = await d64Fund(tx);
    const signIn = await d64SignIn(tx, f);
    const row = await d64Row(tx, f.rowId);
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from group_members where user_id = ${f.invitee} and archived_at is null`;
    return [{
      ok: row.user_id === null && row.invite_email === f.email && row.invite_state === "pending" && n === 0,
      detail: `sign-in ${signIn}; user_id = ${row.user_id ?? "null"}, invite_email = ${row.invite_email}, state = ${row.invite_state}, live memberships of the person = ${n}`,
    }];
  });

  await m1Rows([labels.pending], async (tx) => {
    const f = await d64Fund(tx);
    const row = await d64Row(tx, f.rowId);
    const code = await m1Refusal(tx, (sp) => sp`update group_members set user_id = ${f.invitee}, invite_email = null where id = ${f.rowId}`);
    const other = await m1Refusal(tx, (sp) => sp`update group_members set user_id = ${f.leader} where id = ${f.rowId}`);
    return [{
      ok: row.invite_state === "pending" && code === "23514" && other === "23514",
      detail: `state = ${row.invite_state}; giving a pending row its user = ${code ?? "accepted"}; giving it a user and keeping the address = ${other ?? "accepted"}`,
    }];
  });

  await m1Rows([labels.valid], async (tx) => {
    const f = await d64Fund(tx);
    const bogus = await m1Refusal(tx, (sp) => sp`update group_members set invite_state = 'bogus' where id = ${f.rowId}`);
    const nul = await m1Refusal(tx, (sp) => sp`update group_members set invite_state = null where id = ${f.rowId}`);
    const empty = await m1Refusal(tx, (sp) => sp`update group_members set invite_state = '' where id = ${f.rowId}`);
    const pending = await m1Refusal(tx, (sp) => sp`update group_members set invite_state = 'pending' where id = ${f.rowId}`);
    const accepted = await m1Refusal(tx, (sp) => sp`update group_members set user_id = ${f.invitee}, invite_email = null, invite_state = 'accepted' where id = ${f.rowId}`);
    const g = await d64Fund(tx);
    const declined = await m1Refusal(tx, (sp) => sp`update group_members set invite_state = 'declined', archived_at = now() where id = ${g.rowId}`);
    return [{
      ok: bogus === "23514" && nul !== null && empty === "23514" && pending === null && declined === null && accepted === null,
      detail: `'bogus' = ${bogus ?? "accepted"}, null = ${nul ?? "accepted"}, '' = ${empty ?? "accepted"}; pending = ${pending ?? "ok"}, declined = ${declined ?? "ok"}, accepted = ${accepted ?? "ok"}`,
    }];
  });

  await m1Rows([labels.declinedArchived], async (tx) => {
    const f = await d64Fund(tx);
    const live = await m1Refusal(tx, (sp) => sp`update group_members set invite_state = 'declined' where id = ${f.rowId}`);
    return [{ ok: live === "23514", detail: `declined and still live = ${live ?? "accepted"}` }];
  });

  await m1Rows([labels.declined], async (tx) => {
    const f = await d64Fund(tx);
    await d64Decline(tx, f);
    const read = await d64LeaderReads(tx, f);
    const signIn = await d64SignIn(tx, f);
    const row = await d64Row(tx, f.rowId);
    const after = await d64LeaderReads(tx, f);
    return [{
      ok: read.accounts + read.movements + read.categories === 0 && after.accounts + after.movements + after.categories === 0 && row.user_id === null && row.invite_state === "declined" && row.archived,
      detail: `leader reads ${JSON.stringify(read)} then ${JSON.stringify(after)}; sign-in ${signIn}; user_id = ${row.user_id ?? "null"}, state = ${row.invite_state}, archived = ${row.archived}`,
    }];
  });

  await m1Rows([labels.reinvite], async (tx) => {
    const f = await d64Fund(tx);
    await d64Decline(tx, f);
    await enterUserContext(tx, f.leader);
    const again = await m1Refusal(tx, (sp) => sp`insert into group_members (group_id, name, role, invite_email)
      values (${f.groupId}, 'rls d64 invited again', 'member', ${f.email.toUpperCase()})`);
    const twice = await m1Refusal(tx, (sp) => sp`insert into group_members (group_id, name, role, invite_email)
      values (${f.groupId}, 'rls d64 invited thrice', 'member', ${f.email})`);
    await tx`reset role`;
    const rows = await tx<{ invite_state: string; archived: boolean; user_id: string | null }[]>`
      select invite_state, archived_at is not null as archived, user_id from group_members
      where group_id = ${f.groupId} and lower(invite_email) = lower(${f.email}) or id = ${f.rowId} order by created_at, id`;
    const signIn = await d64SignIn(tx, f);
    const read = await d64LeaderReads(tx, f);
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from group_members where user_id = ${f.invitee} and archived_at is null`;
    const live = rows.filter((r) => !r.archived);
    return [{
      ok: again === null && twice === "23505" && live.length === 1 && live[0].invite_state === "pending" && live[0].user_id === null && read.accounts === 0 && n === 0,
      detail: `re-invite = ${again ?? "landed"}, a second live one = ${twice ?? "landed"}; live rows ${JSON.stringify(live)}; sign-in ${signIn}; leader reads ${read.accounts} accounts; person's live memberships = ${n}`,
    }];
  });

  await m1Rows([labels.accepted], async (tx) => {
    const f = await d64Fund(tx);
    const before = await d64LeaderReads(tx, f);
    await d64Accept(tx, f);
    const read = await d64LeaderReads(tx, f);
    const row = await d64Row(tx, f.rowId);
    return [{
      ok: before.accounts === 0 && read.accounts === f.accounts && read.movements === f.movements && read.categories === f.categories && row.user_id === f.invitee && row.invite_email === null && row.invite_state === "accepted",
      detail: `leader read ${JSON.stringify(before)} before and ${JSON.stringify(read)} after, wanted ${f.accounts}/${f.movements}/${f.categories}; state = ${row.invite_state}, invite_email = ${row.invite_email}`,
    }];
  });

  await m1Rows([labels.grants], async (tx) => {
    const f = await d64Fund(tx);
    const roles = ["authenticated", "anon", "service_role"];
    const held: string[] = [];
    for (const role of roles) {
      for (const priv of ["INSERT", "UPDATE"]) {
        const [{ ok }] = await tx<{ ok: boolean | null }[]>`
          select has_column_privilege(${role}, 'finances.group_members', 'invite_state', ${priv}) as ok`;
        if (ok !== false) held.push(`${role} ${priv}`);
      }
    }
    await enterUserContext(tx, f.leader);
    const update = await m1Refusal(tx, (sp) => sp`update group_members set invite_state = 'accepted' where id = ${f.rowId}`);
    const insert = await m1Refusal(tx, (sp) => sp`insert into group_members (group_id, name, role, invite_email, invite_state)
      values (${f.groupId}, 'rls d64 forged', 'member', ${"forged-" + f.email}, 'accepted')`);
    await tx`reset role`;
    return [{
      ok: held.length === 0 && update === "42501" && insert === "42501",
      detail: `column privileges held: ${held.join(", ") || "none"}; leader UPDATE = ${update ?? "accepted"}, leader INSERT naming the state = ${insert ?? "accepted"}`,
    }];
  });

  await m1Rows([labels.liveAfter], async (tx) => {
    const f = await d64Fund(tx);
    await d64Accept(tx, f);
    const other = randomUUID();
    await tx`insert into groups (id, name, cash_mode) values (${other}, 'rls d64 other', 'shared')`;
    const second = await m1Refusal(tx, (sp) => sp`insert into group_members (group_id, user_id, name, role, invite_state)
      values (${other}, ${f.invitee}, 'rls d64 twice', 'member', 'accepted')`);
    const row = await d64Row(tx, f.rowId);
    return [{
      ok: second === "23505" && row.invite_email === null,
      detail: `a second live row for the accepted person = ${second ?? "landed"}; invite_email = ${row.invite_email}`,
    }];
  });
}

// Assertions 407-409: migration 0067 (RF-154). The invited person reads the invitation addressed to
// them through `private.pending_invitation()`; nobody else reads it, and anon cannot call it.
//
//   D67_MIGRATION_FILE  a path to a SQL file installed instead of db/migrations/0067_*.sql, so a mutation
//                       can be proved red without touching the shared database.
async function d67Install(tx: M1Tx): Promise<void> {
  const dir = path.join(process.cwd(), "db", "migrations");
  const found = readdirSync(dir).find((name) => /^0067_.*\.sql$/.test(name));
  const file = process.env.D67_MIGRATION_FILE ?? (found ? path.join(dir, found) : null);
  if (!file) throw new Error("db/migrations/0067_*.sql does not exist");
  await tx.unsafe(`drop function if exists private.pending_invitation()`);
  for (const statement of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await tx.unsafe(statement);
  }
}

async function d67Read(tx: M1Tx, subject: string, email: string | undefined) {
  await enterUserContext(tx, subject, email);
  try {
    return await tx<{ member_id: string; inviter_name: string; fund_name: string; current_fund_name: string | null; current_fund_has_company: boolean }[]>`
      select * from private.pending_invitation()`;
  } finally {
    await tx`reset role`;
  }
}

async function checkPendingInvitationRead() {
  console.log("");
  const labels = {
    reads: "407. the invited person reads their pending invitation (the row id, the leader's name, the fund name), whatever the case of the address; a person whose own fund has company is told so, a lone one is not",
    nobody: "408. a signed-in person with another address, a declined or withdrawn invitation, or no address reads nothing",
    grants: "409. the function is a stable definer with a fixed search path; authenticated may execute it, anon, service_role and PUBLIC may not",
  };

  await m1Rows([labels.reads], async (tx) => {
    await d67Install(tx);
    const leader = randomUUID();
    const invitee = randomUUID();
    const lone = randomUUID();
    const groupId = randomUUID();
    const ownId = randomUUID();
    const tag = randomUUID().slice(0, 8);
    const email = `d67-${tag}@example.test`;
    await tx`insert into auth.users (id) values (${leader}), (${invitee}), (${lone})`;
    await tx`insert into app_users (id) values (${leader}), (${invitee}), (${lone})`;
    await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls d67 fund', 'shared'), (${ownId}, 'rls d67 own', 'shared')`;
    await tx`insert into group_members (group_id, user_id, name, role) values (${groupId}, ${leader}, 'rls d67 leader', 'leader')`;
    const [{ id: rowId }] = await tx<{ id: string }[]>`
      insert into group_members (group_id, name, role, invite_email)
      values (${groupId}, 'rls d67 invited', 'member', ${email.toUpperCase()}) returning id`;
    const alone = await d67Read(tx, invitee, email);
    await tx`insert into group_members (group_id, user_id, name, role) values (${ownId}, ${invitee}, 'rls d67 own', 'leader')`;
    const soloLeader = await d67Read(tx, invitee, email);
    await tx`insert into group_members (group_id, name, role) values (${ownId}, 'rls d67 company', 'member')`;
    const withCompany = await d67Read(tx, invitee, email);
    void lone;
    const a = alone[0];
    const b = soloLeader[0];
    const c = withCompany[0];
    return [{
      ok: alone.length === 1 && a.member_id === rowId && a.inviter_name === "rls d67 leader" && a.fund_name === "rls d67 fund" && a.current_fund_name === null && a.current_fund_has_company === false
        && soloLeader.length === 1 && b.current_fund_name === "rls d67 own" && b.current_fund_has_company === false
        && withCompany.length === 1 && c.current_fund_name === "rls d67 own" && c.current_fund_has_company === true,
      detail: `no fund = ${JSON.stringify(alone)}, lone leader = ${JSON.stringify(soloLeader)}, with company = ${JSON.stringify(withCompany)}`,
    }];
  });

  await m1Rows([labels.nobody], async (tx) => {
    await d67Install(tx);
    const leader = randomUUID();
    const invitee = randomUUID();
    const other = randomUUID();
    const groupId = randomUUID();
    const email = `d67-${randomUUID().slice(0, 8)}@example.test`;
    await tx`insert into auth.users (id) values (${leader}), (${invitee}), (${other})`;
    await tx`insert into app_users (id) values (${leader}), (${invitee}), (${other})`;
    await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'rls d67 fund', 'shared')`;
    await tx`insert into group_members (group_id, user_id, name, role) values (${groupId}, ${leader}, 'rls d67 leader', 'leader')`;
    const [{ id: rowId }] = await tx<{ id: string }[]>`
      insert into group_members (group_id, name, role, invite_email) values (${groupId}, 'rls d67 invited', 'member', ${email}) returning id`;
    const stranger = await d67Read(tx, other, `d67-other-${randomUUID().slice(0, 8)}@example.test`);
    const noAddress = await d67Read(tx, invitee, undefined);
    const leaderReads = await d67Read(tx, leader, `lead-${email}`);
    await tx`update group_members set invite_state = 'declined', archived_at = now() where id = ${rowId}`;
    const declined = await d67Read(tx, invitee, email);
    return [{
      ok: stranger.length === 0 && noAddress.length === 0 && leaderReads.length === 0 && declined.length === 0,
      detail: `other address = ${stranger.length}, no address = ${noAddress.length}, leader = ${leaderReads.length}, after a decline = ${declined.length}`,
    }];
  });

  await m1Rows([labels.grants], async (tx) => {
    await d67Install(tx);
    const [fn] = await tx<{ definer: boolean; stable: boolean; fixed_path: boolean }[]>`
      select p.prosecdef as definer, p.provolatile = 's' as stable,
        coalesce('search_path=""' = any (p.proconfig), false) as fixed_path
      from pg_proc p where p.oid = 'private.pending_invitation()'::regprocedure`;
    const [acl] = await tx<{ authenticated: boolean; anon: boolean; service: boolean; pub: boolean }[]>`
      select has_function_privilege('authenticated', 'private.pending_invitation()', 'execute') as authenticated,
        has_function_privilege('anon', 'private.pending_invitation()', 'execute') as anon,
        has_function_privilege('service_role', 'private.pending_invitation()', 'execute') as service,
        has_function_privilege(0, 'private.pending_invitation()', 'execute') as pub`;
    const subject = randomUUID();
    const verdict: string[] = [];
    let closed = true;
    for (const role of ["anon", "service_role"] as const) {
      await m1Become(tx, role, subject);
      const code = await m1Refusal(tx, (sp) => sp`select * from private.pending_invitation()`);
      await tx`reset role`;
      verdict.push(`${role} = ${code ?? "accepted"}`);
      if (code !== "42501") closed = false;
    }
    return [{
      ok: fn.definer && fn.stable && fn.fixed_path && acl.authenticated && !acl.anon && !acl.service && !acl.pub && closed,
      detail: `definer = ${fn.definer}, stable = ${fn.stable}, search_path fixed = ${fn.fixed_path}; execute authenticated = ${acl.authenticated}, anon = ${acl.anon}, service_role = ${acl.service}, PUBLIC = ${acl.pub}; calls: ${verdict.join(", ")}`,
    }];
  });
}

// Assertions 410-414: the two predicates the fund's people hang on (RF-59, RF-154) that rows 407-409 and
// 184-190 left open. 410-411: the leader guard refuses a fund with a live member and no live leader (the
// leader archived or demoted, a plain member standing in) and still lets a handover and an abandoned fund
// through. 412-414: `private.pending_invitation()` never shows a withdrawn invitation, returns at most one
// row and it is the oldest, names the fund's live leader and not its oldest member, and does not count an
// archived row as company.
async function checkLeaderGuardAndInvitationPredicates() {
  console.log("");
  const labels = {
    leaderless: "410. a fund with a live member and no live leader is refused at commit: the leader archived, or demoted, while a plain member stays",
    handover: "411. the guard still lets a leadership handover and an abandoned fund (nobody live left) stand",
    withdrawn: "412. an invitation the leader withdrew (pending, archived) is read by nobody, its addressee included",
    oldest: "413. two live invitations to one address read as exactly one row, the oldest",
    company: "414. the invitation names the fund's live leader though an older member exists, and an archived row in the reader's own fund is not company",
  };

  type Fund = { groupId: string; leaderRowId: string };
  const fund = async (tx: M1Tx, name: string, leaderCreatedAt = "2024-01-02"): Promise<Fund & { leader: string }> => {
    const leader = randomUUID();
    const groupId = randomUUID();
    await tx`insert into auth.users (id) values (${leader})`;
    await tx`insert into app_users (id) values (${leader})`;
    await tx`insert into groups (id, name, cash_mode) values (${groupId}, ${name}, 'shared')`;
    const [{ id: leaderRowId }] = await tx<{ id: string }[]>`
      insert into group_members (group_id, user_id, name, role)
      values (${groupId}, ${leader}, ${`${name} leader`}, 'leader') returning id`;
    await backdate(tx, leaderRowId, leaderCreatedAt);
    // The group's own creation-time guard is deferred too; spend it here so only the later writes reach the guard under test.
    await tx`set constraints all immediate`;
    await tx`set constraints all deferred`;
    return { groupId, leaderRowId, leader };
  };
  // A trigger stamps created_at on insert and keeps it on update; the replica role skips every trigger for one write.
  const backdate = async (tx: M1Tx, rowId: string, createdAt: string) => {
    await tx`set local session_replication_role = replica`;
    await tx`update group_members set created_at = ${createdAt}::timestamptz where id = ${rowId}`;
    await tx`set local session_replication_role = origin`;
  };
  const refused = (tx: M1Tx, run: (sp: M1Tx) => Promise<unknown>) =>
    m1Refusal(tx, async (sp) => {
      await run(sp);
      await sp`set constraints all immediate`;
      await sp`set constraints all deferred`;
    });

  await m1Rows([labels.leaderless], async (tx) => {
    const archived = await fund(tx, "rls m82 archived");
    await tx`insert into group_members (group_id, name, role) values (${archived.groupId}, 'rls m82 stays', 'member')`;
    const archive = await refused(tx, (sp) => sp`update group_members set archived_at = now() where id = ${archived.leaderRowId}`);
    const demoted = await fund(tx, "rls m82 demoted");
    await tx`insert into group_members (group_id, name, role) values (${demoted.groupId}, 'rls m82 stays', 'member')`;
    const demote = await refused(tx, (sp) => sp`update group_members set role = 'member' where id = ${demoted.leaderRowId}`);
    return [{
      ok: archive === "23514" && demote === "23514",
      detail: `leader archived = ${archive ?? "accepted"}, leader demoted = ${demote ?? "accepted"}`,
    }];
  });

  await m1Rows([labels.handover], async (tx) => {
    const handed = await fund(tx, "rls m82 handover");
    const heir = randomUUID();
    await tx`insert into auth.users (id) values (${heir})`;
    await tx`insert into app_users (id) values (${heir})`;
    const [{ id: heirId }] = await tx<{ id: string }[]>`
      insert into group_members (group_id, user_id, name, role) values (${handed.groupId}, ${heir}, 'rls m82 heir', 'member') returning id`;
    const handover = await refused(tx, async (sp) => {
      await sp`update group_members set role = 'member' where id = ${handed.leaderRowId}`;
      await sp`update group_members set role = 'leader' where id = ${heirId}`;
    });
    const abandoned = await fund(tx, "rls m82 abandoned");
    const abandon = await refused(tx, (sp) => sp`update group_members set archived_at = now() where id = ${abandoned.leaderRowId}`);
    return [{
      ok: handover === null && abandon === null,
      detail: `handover = ${handover ?? "accepted"}, abandoned fund = ${abandon ?? "accepted"}`,
    }];
  });

  const invitation = async (tx: M1Tx, groupId: string, email: string, createdAt: string, name: string) => {
    const [{ id }] = await tx<{ id: string }[]>`
      insert into group_members (group_id, name, role, invite_email)
      values (${groupId}, ${name}, 'member', ${email}) returning id`;
    await backdate(tx, id, createdAt);
    return id;
  };
  const invitee = async (tx: M1Tx) => {
    const id = randomUUID();
    await tx`insert into auth.users (id) values (${id})`;
    await tx`insert into app_users (id) values (${id})`;
    return id;
  };

  await m1Rows([labels.withdrawn], async (tx) => {
    await d67Install(tx);
    const f = await fund(tx, "rls m82 withdrawn");
    const who = await invitee(tx);
    const email = `m82-${randomUUID().slice(0, 8)}@example.test`;
    const rowId = await invitation(tx, f.groupId, email, "2024-02-01", "rls m82 withdrawn invitee");
    const before = await d67Read(tx, who, email);
    await tx`update group_members set archived_at = now() where id = ${rowId}`;
    const after = await d67Read(tx, who, email);
    return [{
      ok: before.length === 1 && after.length === 0,
      detail: `before the withdrawal = ${before.length}, after = ${after.length}`,
    }];
  });

  await m1Rows([labels.oldest], async (tx) => {
    await d67Install(tx);
    const first = await fund(tx, "rls m82 first fund");
    const second = await fund(tx, "rls m82 second fund");
    const who = await invitee(tx);
    const email = `m82-${randomUUID().slice(0, 8)}@example.test`;
    const newer = await invitation(tx, second.groupId, email, "2024-05-01", "rls m82 newer");
    const older = await invitation(tx, first.groupId, email, "2024-03-01", "rls m82 older");
    const rows = await d67Read(tx, who, email);
    return [{
      ok: rows.length === 1 && rows[0].member_id === older && rows[0].member_id !== newer,
      detail: `rows = ${rows.length}, read ${rows[0]?.member_id}, older = ${older}, newer = ${newer}`,
    }];
  });

  await m1Rows([labels.company], async (tx) => {
    await d67Install(tx);
    const f = await fund(tx, "rls m82 inviter fund", "2024-06-01");
    const [{ id: oldest }] = await tx<{ id: string }[]>`
      insert into group_members (group_id, name, role) values (${f.groupId}, 'rls m82 oldest member', 'member') returning id`;
    await backdate(tx, oldest, "2023-01-01");
    const who = await invitee(tx);
    const own = await fund(tx, "rls m82 reader fund");
    await tx`update group_members set user_id = ${who} where id = ${own.leaderRowId}`;
    await tx`insert into group_members (group_id, name, role, archived_at)
      values (${own.groupId}, 'rls m82 left', 'member', now())`;
    const email = `m82-${randomUUID().slice(0, 8)}@example.test`;
    await invitation(tx, f.groupId, email, "2024-07-01", "rls m82 reader");
    const rows = await d67Read(tx, who, email);
    return [{
      ok: rows.length === 1 && rows[0].inviter_name === "rls m82 inviter fund leader" && rows[0].current_fund_has_company === false,
      detail: `rows = ${JSON.stringify(rows)}`,
    }];
  });
}

// Three rows that each kill a survivor of an earlier mutation round: the invitation stores its address
// trimmed and folded (RF-148), the allow-email script reports the user it created (RF-145), and a
// person's own UPDATE never reaches the adjustment a count booked (RF-137).
async function checkO5M2Survivors() {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const labels = {
    padded: "o5m2-1. an invitation typed with spaces and capitals lists the trimmed, folded address and nothing padded",
    created: "o5m2-2. the first allow-email run for a new address reports «usuario creado», the second «ya tenía usuario»",
    adjustment: "o5m2-3. a person's own UPDATE of the adjustment a count booked changes zero rows; a plain movement of theirs changes one",
  };

  await m1Rows([labels.padded], async (tx) => {
    const group = await m1Group(tx);
    const folded = `inv.${tag}@y.invalid`;
    await enterUserContext(tx, group.leader);
    await tx`insert into group_members (group_id, name, role, invite_email)
      values (${group.groupId}, 'rls o5m2 padded', 'member', ${` Inv.${tag}@Y.invalid `})`;
    await tx`reset role`;
    const listed = await tx<{ email: string }[]>`
      select email from finances.allowed_emails where email like ${`%${tag}%`}`;
    return [{
      ok: listed.length === 1 && listed[0].email === folded,
      detail: `listed = ${JSON.stringify(listed.map((row) => row.email))}, expected only ${folded}`,
    }];
  });

  await m1Rows([labels.adjustment], async (tx) => {
    const owner = randomUUID();
    await tx`insert into auth.users (id) values (${owner})`;
    await tx`insert into app_users (id) values (${owner})`;
    const today = todayInBogota();
    await enterUserContext(tx, owner);
    const [{ id: account }] = await tx<{ id: string }[]>`
      insert into accounts (owner_user_id, name, kind, initial_balance_on)
      values (${owner}, 'rls o5m2 counted', 'asset', ${today}) returning id`;
    const [{ id: spare }] = await tx<{ id: string }[]>`
      insert into accounts (owner_user_id, name, kind, initial_balance_on)
      values (${owner}, 'rls o5m2 spare', 'asset', ${today}) returning id`;
    const [{ id: plain }] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at)
      values (${spare}, ${account}, 100000, ${today}) returning id`;
    const [{ id: counted }] = await tx<{ id: string }[]>`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
      values (${account}, ${today}, 250000) returning id`;
    const booked = await tx<{ id: string; amount_cents: string }[]>`
      select id, amount_cents::text from transactions where reconciliation_id = ${counted}`;
    const edited = await tx`update transactions set description = 'rls o5m2 edit' where reconciliation_id = ${counted} returning id`;
    const plainEdited = await tx`update transactions set description = 'rls o5m2 edit' where id = ${plain} returning id`;
    const after = await tx<{ description: string | null }[]>`
      select description from transactions where reconciliation_id = ${counted}`;
    return [{
      ok: booked.length === 1 && booked[0].amount_cents === "150000" && edited.length === 0 &&
        plainEdited.length === 1 && after[0]?.description !== "rls o5m2 edit",
      detail: `adjustments booked ${booked.length} for ${booked[0]?.amount_cents}, adjustment rows updated ${edited.length}, plain rows updated ${plainEdited.length}, description now ${after[0]?.description ?? "null"}`,
    }];
  });

  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const listUrl = process.env.MIGRATION_DATABASE_URL ?? "";
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/;
  if (!local.test(apiUrl) || !/@(127\.0\.0\.1|localhost):/.test(listUrl)) {
    assert(labels.created, false, `refusing to run against anything but the local stack: API ${apiUrl || "unset"}`);
    return;
  }
  let serviceKey = "";
  try {
    serviceKey = m1StackEnv().SERVICE_ROLE_KEY ?? "";
  } catch (error) {
    assert(labels.created, false, `the local stack's keys could not be read — ${String(error)}`);
    return;
  }
  const address = `harness-o5m2-${tag}@example.invalid`;
  const run = () => {
    const result = spawnSync("npm", ["run", "--silent", "allow-email", "--", address], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, MIGRATION_DATABASE_URL: listUrl, NEXT_PUBLIC_SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: serviceKey },
    });
    return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  try {
    const first = run();
    const users = await sql<{ id: string }[]>`select id from auth.users where email = ${address}`;
    for (const user of users) {
      await sql`insert into harness.identities (user_id, run_id, email, disposition)
        values (${user.id}, ${runId()}, ${address}, 'ephemeral') on conflict (user_id) do nothing`;
    }
    const second = run();
    assert(
      labels.created,
      first.code === 0 && /usuario creado/.test(first.out) && !/ya tenía usuario/.test(first.out) &&
        second.code === 0 && /ya tenía usuario/.test(second.out) && users.length === 1,
      `first exit ${first.code} «${first.out.trim().split("\n").pop()}», second exit ${second.code} «${second.out.trim().split("\n").pop()}», Auth users after the first = ${users.length}`,
    );
  } finally {
    await sql`delete from finances.allowed_emails where email = ${address}`.catch(() => undefined);
    const ids = (await sql<{ id: string }[]>`select id from auth.users where email = ${address}`).map((user) => user.id);
    for (const id of ids) {
      await sql`delete from harness.identities where user_id = ${id}`.catch(() => undefined);
      await sql`delete from app_users where id = ${id}`.catch(() => undefined);
      await sql`delete from auth.users where id = ${id}`.catch(() => undefined);
    }
  }
}

// RF-161: deleting the movement that settled a planned payment returns the payment to pending,
// unlinked, in the same statement, audited as the deleter; while the movement exists every other way
// back is refused, whoever writes it. The leader records and settles a group payment on the shared
// account; the plain member is the fund's writer who deletes the movement. Every row rolls back.
type O6m1Fund = {
  leader: string;
  member: string;
  shared: string;
  category: string;
  payment: string;
  settling: string;
  other: string;
};

type O6m1Payment = { status: string; settled_transaction_id: string | null };

// An expense with its one split, so the deferred split-sum check holds at any `set constraints`.
async function o6m1Movement(tx: M1Tx, account: string, category: string, amount: number, description: string) {
  const [{ id }] = await tx<{ id: string }[]>`
    insert into transactions (from_account_id, amount_cents, occurred_at, description)
    values (${account}, ${amount}, ${todayInBogota()}, ${description}) returning id`;
  await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
    values (${id}, ${category}, ${amount})`;
  return id;
}

// Records a movement and links it the way `settlePlannedPayment` does; returns the rows the claim touched.
async function o6m1Settle(tx: M1Tx, payment: string, account: string, category: string, amount: number) {
  const movement = await o6m1Movement(tx, account, category, amount, "rls o6m1 movement");
  const claimed = await tx`update planned_payments set status = 'done', settled_transaction_id = ${movement}
    where id = ${payment} and status = 'pending' returning id`;
  return { movement, claimed: claimed.length };
}

async function o6m1Fund(tx: M1Tx): Promise<O6m1Fund> {
  const { leader, member, groupId } = await m1Group(tx);
  await tx`update groups set name = 'rls o6m1' where id = ${groupId}`;
  await enterUserContext(tx, leader);
  const [{ id: shared }] = await tx<{ id: string }[]>`
    insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
    values (${groupId}, true, 'rls o6m1 shared cash', 'asset', ${todayInBogota()}) returning id`;
  const [{ id: category }] = await tx<{ id: string }[]>`
    insert into categories (group_id, name, kind)
    values (${groupId}, 'rls o6m1 category', 'expense') returning id`;
  const [{ id: payment }] = await tx<{ id: string }[]>`
    insert into planned_payments (from_account_id, amount_cents, category_id, due_date, description)
    values (${shared}, 30000, ${category}, ${todayInBogota()}, 'rls o6m1 payment') returning id`;
  const settled = await o6m1Settle(tx, payment, shared, category, 30000);
  if (settled.claimed !== 1) throw new Error(`the fixture's settle claimed ${settled.claimed} rows`);
  const other = await o6m1Movement(tx, shared, category, 1000, "rls o6m1 other");
  return { leader, member, shared, category, payment, settling: settled.movement, other };
}

async function o6m1Payment(tx: M1Tx, id: string): Promise<O6m1Payment | undefined> {
  const [row] = await tx<O6m1Payment[]>`
    select status, settled_transaction_id from planned_payments where id = ${id}`;
  return row;
}

function o6m1Show(row: O6m1Payment | undefined, f: O6m1Fund): string {
  if (!row) return "row not visible";
  const link = row.settled_transaction_id === null ? "null"
    : row.settled_transaction_id === f.settling ? "the settling movement"
    : row.settled_transaction_id === f.other ? "the other movement"
    : row.settled_transaction_id;
  return `status ${row.status}, link ${link}`;
}

// Each way back a writer could take by hand, as the fund's writer and as the table owner.
async function o6m1Refusals(
  tx: M1Tx,
  f: O6m1Fund,
  write: (sp: M1Tx) => Promise<unknown>,
): Promise<{ writer: string | null; owner: string | null }> {
  await enterUserContext(tx, f.member);
  const writer = await m1Refusal(tx, write);
  await tx`reset role`;
  const owner = await m1Refusal(tx, write);
  return { writer, owner };
}

async function checkSettlingMovementDelete() {
  console.log("");
  const labels = {
    deleted: "o6m1-1. the fund's writer deletes the movement that settled a planned payment: one row, no error",
    returned: "o6m1-2. after that delete the payment is pending and unlinked",
    sameStatement: "o6m1-3. the next read inside the deleting transaction, before commit, already sees it pending and unlinked",
    unlink: "o6m1-4. clearing the link while its movement exists is refused (23514), by the writer and the owner",
    reopen: "o6m1-5. a done payment whose movement exists cannot return to pending (23514), by the writer and the owner",
    rewrite: "o6m1-6. pointing a settled payment at another movement is refused (23514), by the writer and the owner",
    cancelled: "o6m1-7. a cancelled payment and another done payment are untouched by any delete",
    resettle: "o6m1-8. the returned payment settles again into a new movement, and that new link is permanent",
    audit: "o6m1-9. the return leaves one planned_payments UPDATE in audit_log, actor the deleter, done→pending",
    tail: "o6m1-10. the rolled-back RF-161 transactions leave no fixture behind",
  };

  await m1Rows([labels.deleted], async (tx) => {
    const f = await o6m1Fund(tx);
    await enterUserContext(tx, f.member);
    const deleted = await tx`delete from transactions where id = ${f.settling} returning id`;
    await tx`reset role`;
    const [{ n: left }] = await tx<{ n: number }[]>`
      select count(*)::int as n from transactions where id = ${f.settling}`;
    return [{
      ok: deleted.length === 1 && left === 0,
      detail: `rows deleted ${deleted.length}, the movement still there ${left}`,
    }];
  });

  await m1Rows([labels.returned], async (tx) => {
    const f = await o6m1Fund(tx);
    await enterUserContext(tx, f.member);
    await tx`delete from transactions where id = ${f.settling}`;
    // Fires anything deferred, as the commit would.
    await tx`set constraints all immediate`;
    await tx`reset role`;
    const row = await o6m1Payment(tx, f.payment);
    return [{
      ok: row?.status === "pending" && row.settled_transaction_id === null,
      detail: o6m1Show(row, f),
    }];
  });

  await m1Rows([labels.sameStatement], async (tx) => {
    const f = await o6m1Fund(tx);
    await enterUserContext(tx, f.member);
    await tx`delete from transactions where id = ${f.settling}`;
    const row = await o6m1Payment(tx, f.payment);
    return [{
      ok: row?.status === "pending" && row.settled_transaction_id === null,
      detail: `read by the deleter before commit: ${o6m1Show(row, f)}`,
    }];
  });

  await m1Rows([labels.unlink], async (tx) => {
    const f = await o6m1Fund(tx);
    const cleared = await o6m1Refusals(tx, f, (sp) =>
      sp`update planned_payments set settled_transaction_id = null where id = ${f.payment}`);
    // The exact shape of the return, written by hand while the movement still exists.
    const returned = await o6m1Refusals(tx, f, (sp) =>
      sp`update planned_payments set status = 'pending', settled_transaction_id = null where id = ${f.payment}`);
    const row = await o6m1Payment(tx, f.payment);
    return [{
      ok: [cleared.writer, cleared.owner, returned.writer, returned.owner].every((code) => code === "23514") &&
        row?.status === "done" && row.settled_transaction_id === f.settling,
      detail: `link cleared: writer ${cleared.writer ?? "accepted"}, owner ${cleared.owner ?? "accepted"}; ` +
        `pending and unlinked: writer ${returned.writer ?? "accepted"}, owner ${returned.owner ?? "accepted"}; after: ${o6m1Show(row, f)}`,
    }];
  });

  await m1Rows([labels.reopen], async (tx) => {
    const f = await o6m1Fund(tx);
    const reopened = await o6m1Refusals(tx, f, (sp) =>
      sp`update planned_payments set status = 'pending' where id = ${f.payment}`);
    const row = await o6m1Payment(tx, f.payment);
    return [{
      ok: reopened.writer === "23514" && reopened.owner === "23514" &&
        row?.status === "done" && row.settled_transaction_id === f.settling,
      detail: `writer ${reopened.writer ?? "accepted"}, owner ${reopened.owner ?? "accepted"}; after: ${o6m1Show(row, f)}`,
    }];
  });

  await m1Rows([labels.rewrite], async (tx) => {
    const f = await o6m1Fund(tx);
    const rewritten = await o6m1Refusals(tx, f, (sp) =>
      sp`update planned_payments set settled_transaction_id = ${f.other} where id = ${f.payment}`);
    const row = await o6m1Payment(tx, f.payment);
    return [{
      ok: rewritten.writer === "23514" && rewritten.owner === "23514" &&
        row?.status === "done" && row.settled_transaction_id === f.settling,
      detail: `writer ${rewritten.writer ?? "accepted"}, owner ${rewritten.owner ?? "accepted"}; after: ${o6m1Show(row, f)}`,
    }];
  });

  await m1Rows([labels.cancelled], async (tx) => {
    const f = await o6m1Fund(tx);
    await enterUserContext(tx, f.leader);
    const [{ id: cancelled }] = await tx<{ id: string }[]>`
      insert into planned_payments (from_account_id, amount_cents, due_date, description)
      values (${f.shared}, 2000, ${todayInBogota()}, 'rls o6m1 cancelled') returning id`;
    // The app's cancel path: only a pending payment is cancelled.
    await tx`update planned_payments set status = 'cancelled' where id = ${cancelled} and status = 'pending'`;
    const [{ id: bystander }] = await tx<{ id: string }[]>`
      insert into planned_payments (from_account_id, amount_cents, due_date, description)
      values (${f.shared}, 1000, ${todayInBogota()}, 'rls o6m1 bystander') returning id`;
    await tx`update planned_payments set status = 'done', settled_transaction_id = ${f.other}
      where id = ${bystander} and status = 'pending'`;
    const unrelated = await o6m1Movement(tx, f.shared, f.category, 500, "rls o6m1 unrelated");
    await tx`reset role`;
    const [{ last }] = await tx<{ last: string | null }[]>`select max(id)::text as last from audit_log`;

    await enterUserContext(tx, f.member);
    await tx`delete from transactions where id = ${unrelated}`;
    await tx`reset role`;
    const afterUnrelated = await o6m1Payment(tx, cancelled);
    await enterUserContext(tx, f.member);
    const settlingDelete = await m1Refusal(tx, (sp) => sp`delete from transactions where id = ${f.settling}`);
    await tx`reset role`;
    const afterSettling = await o6m1Payment(tx, cancelled);
    const other = await o6m1Payment(tx, bystander);
    const [{ n: touched }] = await tx<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where entity = 'planned_payments' and record_id in (${cancelled}, ${bystander}) and id > ${last ?? "0"}::bigint`;
    return [{
      ok: afterUnrelated?.status === "cancelled" && afterUnrelated.settled_transaction_id === null &&
        settlingDelete === null &&
        afterSettling?.status === "cancelled" && afterSettling.settled_transaction_id === null &&
        other?.status === "done" && other.settled_transaction_id === f.other && touched === 0,
      detail: `cancelled after the unrelated delete: ${o6m1Show(afterUnrelated, f)}; settling delete ${settlingDelete ?? "accepted"}; ` +
        `cancelled after it: ${o6m1Show(afterSettling, f)}; the other done payment: ${o6m1Show(other, f)}; audit rows on either ${touched}`,
    }];
  });

  await m1Rows([labels.resettle], async (tx) => {
    const f = await o6m1Fund(tx);
    await enterUserContext(tx, f.member);
    await tx`delete from transactions where id = ${f.settling}`;
    await enterUserContext(tx, f.leader);
    const again = await o6m1Settle(tx, f.payment, f.shared, f.category, 30000);
    const row = await o6m1Payment(tx, f.payment);
    const rewrite = await m1Refusal(tx, (sp) =>
      sp`update planned_payments set settled_transaction_id = ${f.other} where id = ${f.payment}`);
    const reopen = await m1Refusal(tx, (sp) =>
      sp`update planned_payments set status = 'pending' where id = ${f.payment}`);
    const unlink = await m1Refusal(tx, (sp) =>
      sp`update planned_payments set settled_transaction_id = null where id = ${f.payment}`);
    return [{
      ok: again.claimed === 1 && row?.status === "done" && row.settled_transaction_id === again.movement &&
        rewrite === "23514" && reopen === "23514" && unlink === "23514",
      detail: `settle claimed ${again.claimed}, ${row?.status ?? "row not visible"} linked to the new movement ` +
        `${row?.settled_transaction_id === again.movement}; then rewrite ${rewrite ?? "accepted"}, reopen ${reopen ?? "accepted"}, unlink ${unlink ?? "accepted"}`,
    }];
  });

  await m1Rows([labels.audit], async (tx) => {
    const f = await o6m1Fund(tx);
    const [{ last }] = await tx<{ last: string | null }[]>`select max(id)::text as last from audit_log`;
    await enterUserContext(tx, f.member);
    await tx`delete from transactions where id = ${f.settling}`;
    await tx`reset role`;
    const rows = await tx<{
      action: string;
      actor_user_id: string | null;
      before_status: string | null;
      before_link: string | null;
      after_status: string | null;
      after_link: string | null;
    }[]>`
      select action, actor_user_id,
        before_data->>'status' as before_status, before_data->>'settled_transaction_id' as before_link,
        after_data->>'status' as after_status, after_data->>'settled_transaction_id' as after_link
      from audit_log
      where entity = 'planned_payments' and record_id = ${f.payment} and id > ${last ?? "0"}::bigint
      order by id`;
    const [row] = rows;
    return [{
      ok: rows.length === 1 && row.action === "UPDATE" && row.actor_user_id === f.member &&
        row.before_status === "done" && row.before_link === f.settling &&
        row.after_status === "pending" && row.after_link === null,
      detail: `rows ${rows.length}` + (row
        ? `, action ${row.action}, actor ${row.actor_user_id === f.member ? "the deleter" : row.actor_user_id === f.leader ? "the leader" : row.actor_user_id}, ` +
          `${row.before_status}→${row.after_status}, link before is the settling movement ${row.before_link === f.settling}, link after ${row.after_link}`
        : ""),
    }];
  });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ groups, payments, movements }] = await sql<{ groups: number; payments: number; movements: number }[]>`
    select
      (select count(*)::int from groups where name like 'rls o6m1%') as groups,
      (select count(*)::int from planned_payments where description like 'rls o6m1%') as payments,
      (select count(*)::int from transactions where description like 'rls o6m1%') as movements`;
  assert(
    labels.tail,
    afterUser === "postgres" && groups === 0 && payments === 0 && movements === 0,
    `current_user = ${afterUser}, groups ${groups}, payments ${payments}, movements ${movements} named 'rls o6m1%'`,
  );
}

// RF-161 return keeps the payment's scope: the FK's set-null that returns a payment to pending runs as an UPDATE, and
// it must leave the owner, the group and every other column as they were, whoever deleted the movement. A direct
// update by a member still re-derives the scope from the accounts. Every row rolls back.
type O6m1bFund = {
  leader: string;
  member: string;
  groupId: string;
  shared: string;
  groupCategory: string;
  personal: string;
  personalCategory: string;
};

type O6m1bRow = {
  status: string;
  settled_transaction_id: string | null;
  owner_user_id: string | null;
  group_id: string | null;
  rest: Record<string, unknown>;
};

// The member is the plain member A who owns the personal payment; the leader is someone else in the fund.
async function o6m1bFund(tx: M1Tx): Promise<O6m1bFund> {
  const { leader, member, groupId } = await m1Group(tx);
  await tx`update groups set name = 'rls o6m1b' where id = ${groupId}`;
  await enterUserContext(tx, leader);
  const [{ id: shared }] = await tx<{ id: string }[]>`
    insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
    values (${groupId}, true, 'rls o6m1b shared cash', 'asset', ${todayInBogota()}) returning id`;
  const [{ id: groupCategory }] = await tx<{ id: string }[]>`
    insert into categories (group_id, name, kind)
    values (${groupId}, 'rls o6m1b group category', 'expense') returning id`;
  await enterUserContext(tx, member);
  const [{ id: personal }] = await tx<{ id: string }[]>`
    insert into accounts (owner_user_id, name, kind, initial_balance_on)
    values (${member}, 'rls o6m1b member cash', 'asset', ${todayInBogota()}) returning id`;
  const [{ id: personalCategory }] = await tx<{ id: string }[]>`
    insert into categories (owner_user_id, name, kind)
    values (${member}, 'rls o6m1b member category', 'expense') returning id`;
  await tx`reset role`;
  return { leader, member, groupId, shared, groupCategory, personal, personalCategory };
}

// A's personal payment on A's own account, settled by `account`'s movement as A. Leaves the role reset.
async function o6m1bPersonalSettled(tx: M1Tx, f: O6m1bFund, account: string, category: string) {
  await enterUserContext(tx, f.member);
  const [{ id: payment }] = await tx<{ id: string }[]>`
    insert into planned_payments (from_account_id, amount_cents, category_id, due_date, remind_on, description)
    values (${f.personal}, 42000, ${f.personalCategory}, ${todayInBogota()}, ${todayInBogota()}, 'rls o6m1b payment')
    returning id`;
  const movement = await o6m1Movement(tx, account, category, 42000, "rls o6m1b movement");
  const claimed = await tx`update planned_payments set status = 'done', settled_transaction_id = ${movement}
    where id = ${payment} and status = 'pending' returning id`;
  await tx`reset role`;
  if (claimed.length !== 1) throw new Error(`the fixture's settle claimed ${claimed.length} rows`);
  return { payment, movement };
}

// Read as the table owner, so no policy hides the row whichever scope it ended in.
async function o6m1bRead(tx: M1Tx, id: string): Promise<O6m1bRow | undefined> {
  const [row] = await tx<O6m1bRow[]>`
    select status, settled_transaction_id, owner_user_id, group_id,
      to_jsonb(p) - 'status' - 'settled_transaction_id' as rest
    from planned_payments p where id = ${id}`;
  return row;
}

function o6m1bWho(id: string | null, f: O6m1bFund): string {
  return id === null ? "null" : id === f.member ? "A" : id === f.leader ? "the leader" : id === f.groupId ? "the group" : id;
}

function o6m1bShow(row: O6m1bRow | undefined, f: O6m1bFund): string {
  if (!row) return "row gone";
  return `status ${row.status}, link ${row.settled_transaction_id ?? "null"}, owner ${o6m1bWho(row.owner_user_id, f)}, group ${o6m1bWho(row.group_id, f)}`;
}

// Every column but status and link whose value moved between the two reads.
function o6m1bChanged(before: O6m1bRow | undefined, after: O6m1bRow | undefined): string[] {
  if (!before || !after) return ["row missing"];
  const keys = new Set([...Object.keys(before.rest), ...Object.keys(after.rest)]);
  return [...keys].filter((key) => JSON.stringify(before.rest[key]) !== JSON.stringify(after.rest[key]));
}

async function checkReturnKeepsScope() {
  console.log("");
  const labels = {
    member: "o6m1b-1. another member deletes the shared movement that settled A's personal payment: pending, unlinked, owner still A, nothing else moved",
    tableOwner: "o6m1b-2. the table owner deletes A's own settling movement, as someone else and as no one: pending, unlinked, owner still A",
    scope: "o6m1b-3. a return whose stored scope differs from what its accounts would derive keeps the stored owner, group and every other column",
    direct: "o6m1b-4. a member's direct update still derives the scope: moved onto A's account it is A's; moved onto the shared account it is the group's",
    audit: "o6m1b-5. the return leaves one planned_payments UPDATE in audit_log, done→pending, owner A before and after",
    tail: "o6m1b-6. the rolled-back o6m1b transactions leave no fixture behind",
  };

  await m1Rows([labels.member], async (tx) => {
    const f = await o6m1bFund(tx);
    const { payment, movement } = await o6m1bPersonalSettled(tx, f, f.shared, f.groupCategory);
    const before = await o6m1bRead(tx, payment);
    await enterUserContext(tx, f.leader);
    const deleted = await tx`delete from transactions where id = ${movement} returning id`;
    await tx`set constraints all immediate`;
    await tx`reset role`;
    const after = await o6m1bRead(tx, payment);
    const changed = o6m1bChanged(before, after);
    return [{
      ok: deleted.length === 1 && after?.status === "pending" && after.settled_transaction_id === null &&
        after.owner_user_id === f.member && after.group_id === null && changed.length === 0,
      detail: `rows deleted ${deleted.length}; after: ${o6m1bShow(after, f)}; other columns changed: ${changed.join(", ") || "none"}`,
    }];
  });

  await m1Rows([labels.tableOwner], async (tx) => {
    const f = await o6m1bFund(tx);
    const asLeader = await o6m1bPersonalSettled(tx, f, f.personal, f.personalCategory);
    const asNoOne = await o6m1bPersonalSettled(tx, f, f.personal, f.personalCategory);
    // The table owner, with the leader's claims left in the session: auth.uid() is the leader.
    await enterUserContext(tx, f.leader);
    await tx`reset role`;
    const leaderDelete = await m1Refusal(tx, (sp) => sp`delete from transactions where id = ${asLeader.movement}`);
    // The table owner with no claims at all: auth.uid() is null.
    await tx`select set_config('request.jwt.claims', '', true)`;
    const noOneDelete = await m1Refusal(tx, (sp) => sp`delete from transactions where id = ${asNoOne.movement}`);
    const one = await o6m1bRead(tx, asLeader.payment);
    const two = await o6m1bRead(tx, asNoOne.payment);
    const back = (row: O6m1bRow | undefined) =>
      row?.status === "pending" && row.settled_transaction_id === null && row.owner_user_id === f.member && row.group_id === null;
    return [{
      ok: leaderDelete === null && noOneDelete === null && back(one) && back(two),
      detail: `with the leader's claims: delete ${leaderDelete ?? "accepted"}, ${o6m1bShow(one, f)}; ` +
        `with no claims: delete ${noOneDelete ?? "accepted"}, ${o6m1bShow(two, f)}`,
    }];
  });

  await m1Rows([labels.scope], async (tx) => {
    const f = await o6m1bFund(tx);
    const { payment, movement } = await o6m1bPersonalSettled(tx, f, f.personal, f.personalCategory);
    // A's account placed in the group after the payment was planned: deriving the scope from the accounts now
    // yields the group, while the stored scope is A's. Only a return that keeps the stored row tells them apart.
    await tx`update accounts set owner_user_id = null, group_id = ${f.groupId}, is_shared = true where id = ${f.personal}`;
    const before = await o6m1bRead(tx, payment);
    await enterUserContext(tx, f.leader);
    await tx`reset role`;
    const deleteCode = await m1Refusal(tx, (sp) => sp`delete from transactions where id = ${movement}`);
    const after = await o6m1bRead(tx, payment);
    const changed = o6m1bChanged(before, after);
    return [{
      ok: deleteCode === null && after?.status === "pending" && after.settled_transaction_id === null &&
        after.owner_user_id === f.member && after.group_id === null && changed.length === 0,
      detail: `delete ${deleteCode ?? "accepted"}; after: ${o6m1bShow(after, f)}; other columns changed: ${changed.join(", ") || "none"}`,
    }];
  });

  await m1Rows([labels.direct], async (tx) => {
    const f = await o6m1bFund(tx);
    await enterUserContext(tx, f.leader);
    const [{ id: groupPayment }] = await tx<{ id: string }[]>`
      insert into planned_payments (from_account_id, amount_cents, due_date, description)
      values (${f.shared}, 5000, ${todayInBogota()}, 'rls o6m1b group payment') returning id`;
    await enterUserContext(tx, f.member);
    const [{ id: personalPayment }] = await tx<{ id: string }[]>`
      insert into planned_payments (from_account_id, amount_cents, due_date, description)
      values (${f.personal}, 6000, ${todayInBogota()}, 'rls o6m1b personal payment') returning id`;
    const toPersonal = await tx`update planned_payments set from_account_id = ${f.personal}
      where id = ${groupPayment} returning id`;
    const toShared = await tx`update planned_payments set from_account_id = ${f.shared}
      where id = ${personalPayment} returning id`;
    await tx`reset role`;
    const mine = await o6m1bRead(tx, groupPayment);
    const ours = await o6m1bRead(tx, personalPayment);
    return [{
      ok: toPersonal.length === 1 && toShared.length === 1 &&
        mine?.owner_user_id === f.member && mine.group_id === null &&
        ours?.owner_user_id === null && ours.group_id === f.groupId,
      detail: `the group payment moved onto A's account by A (${toPersonal.length} row): ${o6m1bShow(mine, f)}; ` +
        `A's payment moved onto the shared account (${toShared.length} row): ${o6m1bShow(ours, f)}`,
    }];
  });

  await m1Rows([labels.audit], async (tx) => {
    const f = await o6m1bFund(tx);
    const { payment, movement } = await o6m1bPersonalSettled(tx, f, f.shared, f.groupCategory);
    const [{ last }] = await tx<{ last: string | null }[]>`select max(id)::text as last from audit_log`;
    await enterUserContext(tx, f.leader);
    await tx`delete from transactions where id = ${movement}`;
    await tx`reset role`;
    const rows = await tx<{
      action: string;
      owner_user_id: string | null;
      before_status: string | null;
      after_status: string | null;
      before_owner: string | null;
      after_owner: string | null;
      after_group: string | null;
    }[]>`
      select action, owner_user_id,
        before_data->>'status' as before_status, after_data->>'status' as after_status,
        before_data->>'owner_user_id' as before_owner, after_data->>'owner_user_id' as after_owner,
        after_data->>'group_id' as after_group
      from audit_log
      where entity = 'planned_payments' and record_id = ${payment} and id > ${last ?? "0"}::bigint
      order by id`;
    const [row] = rows;
    return [{
      ok: rows.length === 1 && row.action === "UPDATE" && row.before_status === "done" && row.after_status === "pending" &&
        row.before_owner === f.member && row.after_owner === f.member && row.after_group === null &&
        row.owner_user_id === f.member,
      detail: `rows ${rows.length}` + (row
        ? `, action ${row.action}, ${row.before_status}→${row.after_status}, owner before ${o6m1bWho(row.before_owner, f)}, ` +
          `after ${o6m1bWho(row.after_owner, f)}, group after ${o6m1bWho(row.after_group, f)}, the log's owner ${o6m1bWho(row.owner_user_id, f)}`
        : ""),
    }];
  });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ groups, payments, movements, accounts }] = await sql<{
    groups: number; payments: number; movements: number; accounts: number;
  }[]>`
    select
      (select count(*)::int from groups where name like 'rls o6m1b%') as groups,
      (select count(*)::int from planned_payments where description like 'rls o6m1b%') as payments,
      (select count(*)::int from transactions where description like 'rls o6m1b%') as movements,
      (select count(*)::int from accounts where name like 'rls o6m1b%') as accounts`;
  assert(
    labels.tail,
    afterUser === "postgres" && groups === 0 && payments === 0 && movements === 0 && accounts === 0,
    `current_user = ${afterUser}, groups ${groups}, payments ${payments}, movements ${movements}, accounts ${accounts} named 'rls o6m1b%'`,
  );
}

// RF-162: a movement is never dated before the opening day of an account it names, and an account's opening day never
// moves past one of its movements. Days are civil `date` columns compared as days, so the fixture names fixed past days
// and no clock or zone enters. Every row rolls back.
const O6M6_OPEN = "2026-03-10";
const O6M6_EVE = "2026-03-09";
const O6M6_MID = "2026-03-20";
const O6M6_LATER_OPEN = "2026-04-10";

type O6m6Fund = {
  leader: string;
  member: string;
  groupId: string;
  // Shared, opened on O6M6_OPEN.
  shared: string;
  // Shared, opened on O6M6_LATER_OPEN.
  later: string;
  expense: string;
  income: string;
};

async function o6m6Rows(labels: string[], body: (tx: M1Tx) => Promise<M1Verdict[]>): Promise<void> {
  let verdicts: M1Verdict[] = labels.map(() => ({ ok: false, detail: "the body never ran" }));
  await sql
    .begin(async (tx) => {
      verdicts = await body(tx);
      throw M1_ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error === M1_ROLLBACK) return;
      verdicts = labels.map(() => ({ ok: false, detail: `aborted — ${describeRefusal(error)}` }));
    });
  labels.forEach((label, i) => assert(label, verdicts[i].ok, verdicts[i].detail));
}

async function o6m6Fund(tx: M1Tx): Promise<O6m6Fund> {
  const { leader, member, groupId } = await m1Group(tx);
  await tx`update groups set name = 'rls o6m6' where id = ${groupId}`;
  await enterUserContext(tx, leader);
  const [{ id: shared }] = await tx<{ id: string }[]>`
    insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
    values (${groupId}, true, 'rls o6m6 shared', 'asset', ${O6M6_OPEN}) returning id`;
  const [{ id: later }] = await tx<{ id: string }[]>`
    insert into accounts (group_id, is_shared, name, kind, initial_balance_on)
    values (${groupId}, true, 'rls o6m6 later', 'asset', ${O6M6_LATER_OPEN}) returning id`;
  const [{ id: expense }] = await tx<{ id: string }[]>`
    insert into categories (group_id, name, kind) values (${groupId}, 'rls o6m6 expense', 'expense') returning id`;
  const [{ id: income }] = await tx<{ id: string }[]>`
    insert into categories (group_id, name, kind) values (${groupId}, 'rls o6m6 income', 'income') returning id`;
  await tx`reset role`;
  return { leader, member, groupId, shared, later, expense, income };
}

// One movement with its split when it is an income or an expense, in the session's current role.
async function o6m6Movement(
  tx: M1Tx,
  legs: { from?: string; to?: string },
  day: string,
  category: string | null,
  amount = 1000,
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at, description)
    values (${legs.from ?? null}, ${legs.to ?? null}, ${amount}, ${day}, 'rls o6m6 movement') returning id`;
  if (category) {
    await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${id}, ${category}, ${amount})`;
  }
  return id;
}

// The sqlstate an insert is refused with, or null when it saved and its deferred checks held.
async function o6m6Insert(
  tx: M1Tx,
  legs: { from?: string; to?: string },
  day: string,
  category: string | null,
): Promise<string | null> {
  return m1Refusal(tx, async (sp) => {
    await o6m6Movement(sp, legs, day, category);
    await sp`set constraints all immediate`;
    await sp`set constraints all deferred`;
  });
}

async function o6m6Day(tx: M1Tx, id: string): Promise<string | undefined> {
  const [row] = await tx<{ day: string }[]>`select occurred_at::text as day from transactions where id = ${id}`;
  return row?.day;
}

async function o6m6Opening(tx: M1Tx, id: string): Promise<string | undefined> {
  const [row] = await tx<{ day: string }[]>`select initial_balance_on::text as day from accounts where id = ${id}`;
  return row?.day;
}

// Moves an account's opening with every trigger off, as the table owner, so a movement already stored ends up before
// it: the state RF-162 leaves alone. Leaves the role reset.
async function o6m6Predate(tx: M1Tx, account: string, day: string): Promise<void> {
  await tx`reset role`;
  await tx`set local session_replication_role = replica`;
  await tx`update accounts set initial_balance_on = ${day} where id = ${account}`;
  await tx`set local session_replication_role = origin`;
}

function o6m6Code(code: string | null): string {
  return code ?? "accepted";
}

async function checkMovementBeforeOpening() {
  console.log("");
  const labels = {
    fromEve: "o6m6-1. an expense dated the day before its account opens is refused with MO001",
    toEve: "o6m6-2. an income dated the day before its account opens is refused with MO001",
    transfer: "o6m6-3. a transfer dated before either side opens is refused with MO001, whichever side opened later",
    onTheDay: "o6m6-4. an expense, an income and a transfer dated an account's opening day save",
    redate: "o6m6-5. moving a movement's date before its account opens is refused with MO001 and the date stays",
    reaccount: "o6m6-6. moving a movement onto an account opened after its date, by either leg, is refused with MO001",
    oldRow: "o6m6-7. a movement already stored before its opening saves an amount, split and description edit, the form's own included",
    openingPast: "o6m6-8. moving an opening past one of the account's movements, by either leg, is refused with MO002",
    openingClear: "o6m6-9. moving an opening to the first movement's day, earlier, on an empty account, or re-sending it unchanged saves",
    adjustment: "o6m6-10. a reconciliation before the opening keeps its RC002 refusal; one on the opening day books its adjustment",
    underRls: "o6m6-11. as authenticated both refusals carry their codes, and one who left the fund cannot move past a movement they no longer read",
    owner: "o6m6-12. the table owner with no claims, as the import and the nightly run write, is refused a pre-opening movement with MO001",
    definer: "o6m6-13. both guards run as definers with an empty search_path, and no API role may execute them",
    tail: "o6m6-14. the rolled-back RF-162 transactions leave no fixture behind",
  };

  await o6m6Rows([labels.fromEve], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const code = await o6m6Insert(tx, { from: f.shared }, O6M6_EVE, f.expense);
    return [{ ok: code === "MO001", detail: `expense from the account opened ${O6M6_OPEN}, dated ${O6M6_EVE}: ${o6m6Code(code)}` }];
  });

  await o6m6Rows([labels.toEve], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const code = await o6m6Insert(tx, { to: f.shared }, O6M6_EVE, f.income);
    return [{ ok: code === "MO001", detail: `income into the account opened ${O6M6_OPEN}, dated ${O6M6_EVE}: ${o6m6Code(code)}` }];
  });

  await o6m6Rows([labels.transfer], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const intoLater = await o6m6Insert(tx, { from: f.shared, to: f.later }, O6M6_MID, null);
    const outOfLater = await o6m6Insert(tx, { from: f.later, to: f.shared }, O6M6_MID, null);
    const beforeBoth = await o6m6Insert(tx, { from: f.shared, to: f.later }, O6M6_EVE, null);
    return [{
      ok: intoLater === "MO001" && outOfLater === "MO001" && beforeBoth === "MO001",
      detail: `dated ${O6M6_MID}, the destination opened ${O6M6_LATER_OPEN}: ${o6m6Code(intoLater)}; the source opened then: ` +
        `${o6m6Code(outOfLater)}; dated ${O6M6_EVE}, before both: ${o6m6Code(beforeBoth)}`,
    }];
  });

  await o6m6Rows([labels.onTheDay], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const expense = await o6m6Insert(tx, { from: f.shared }, O6M6_OPEN, f.expense);
    const income = await o6m6Insert(tx, { to: f.shared }, O6M6_OPEN, f.income);
    const transfer = await o6m6Insert(tx, { from: f.shared, to: f.later }, O6M6_LATER_OPEN, null);
    return [{
      ok: expense === null && income === null && transfer === null,
      detail: `expense on ${O6M6_OPEN}: ${o6m6Code(expense)}; income on ${O6M6_OPEN}: ${o6m6Code(income)}; ` +
        `transfer into the account opened ${O6M6_LATER_OPEN}, on that day: ${o6m6Code(transfer)}`,
    }];
  });

  await o6m6Rows([labels.redate], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const id = await o6m6Movement(tx, { from: f.shared }, O6M6_MID, f.expense);
    const code = await m1Refusal(tx, (sp) => sp`update transactions set occurred_at = ${O6M6_EVE} where id = ${id}`);
    const day = await o6m6Day(tx, id);
    return [{
      ok: code === "MO001" && day === O6M6_MID,
      detail: `expense on ${O6M6_MID} moved to ${O6M6_EVE}: ${o6m6Code(code)}, stored day ${day}`,
    }];
  });

  await o6m6Rows([labels.reaccount], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const expense = await o6m6Movement(tx, { from: f.shared }, O6M6_MID, f.expense);
    const income = await o6m6Movement(tx, { to: f.shared }, O6M6_MID, f.income);
    const viaFrom = await m1Refusal(tx, (sp) => sp`update transactions set from_account_id = ${f.later} where id = ${expense}`);
    const viaTo = await m1Refusal(tx, (sp) => sp`update transactions set to_account_id = ${f.later} where id = ${income}`);
    return [{
      ok: viaFrom === "MO001" && viaTo === "MO001",
      detail: `movements on ${O6M6_MID} moved onto the account opened ${O6M6_LATER_OPEN}: the expense's source ${o6m6Code(viaFrom)}, ` +
        `the income's destination ${o6m6Code(viaTo)}`,
    }];
  });

  await o6m6Rows([labels.oldRow], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const id = await o6m6Movement(tx, { from: f.shared }, O6M6_MID, f.expense, 1000);
    // The account now opens after the movement it already had.
    await o6m6Predate(tx, f.shared, O6M6_LATER_OPEN);
    await enterUserContext(tx, f.member);
    const amount = await m1Refusal(tx, async (sp) => {
      await sp`update transactions set amount_cents = 2000 where id = ${id}`;
      await sp`update transaction_splits set amount_cents = 2000 where transaction_id = ${id}`;
      await sp`set constraints all immediate`;
      await sp`set constraints all deferred`;
    });
    const description = await m1Refusal(tx, (sp) =>
      sp`update transactions set description = 'rls o6m6 corrected' where id = ${id}`);
    // `updateTransaction` names every column the form carries, the unchanged date and accounts among them.
    const form = await m1Refusal(tx, async (sp) => {
      await sp`update transactions set from_account_id = ${f.shared}, to_account_id = null, amount_cents = 3000,
        occurred_at = ${O6M6_MID}, description = 'rls o6m6 from the form' where id = ${id}`;
      await sp`update transaction_splits set amount_cents = 3000 where transaction_id = ${id}`;
      await sp`set constraints all immediate`;
      await sp`set constraints all deferred`;
    });
    await tx`reset role`;
    const [row] = await tx<{ day: string; amount: number }[]>`
      select occurred_at::text as day, amount_cents::int as amount from transactions where id = ${id}`;
    return [{
      ok: amount === null && description === null && form === null && row?.day === O6M6_MID && row.amount === 3000,
      detail: `a movement on ${O6M6_MID} in an account opening ${O6M6_LATER_OPEN}: amount and split ${o6m6Code(amount)}, ` +
        `description ${o6m6Code(description)}, the form naming the same day and account ${o6m6Code(form)}; ` +
        `stored day ${row?.day}, amount ${row?.amount}`,
    }];
  });

  await o6m6Rows([labels.openingPast], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    // The expense names the shared account as its source; the transfer names the later one as its destination.
    await o6m6Movement(tx, { from: f.shared }, O6M6_MID, f.expense);
    await o6m6Movement(tx, { from: f.shared, to: f.later }, "2026-04-20", null);
    const source = await m1Refusal(tx, (sp) =>
      sp`update accounts set initial_balance_on = '2026-03-21' where id = ${f.shared}`);
    const destination = await m1Refusal(tx, (sp) =>
      sp`update accounts set initial_balance_on = '2026-04-21' where id = ${f.later}`);
    const shared = await o6m6Opening(tx, f.shared);
    const later = await o6m6Opening(tx, f.later);
    return [{
      ok: source === "MO002" && destination === "MO002" && shared === O6M6_OPEN && later === O6M6_LATER_OPEN,
      detail: `an expense out of the account on ${O6M6_MID}, opening moved to 2026-03-21: ${o6m6Code(source)}; ` +
        `a transfer into the account on 2026-04-20, opening moved to 2026-04-21: ${o6m6Code(destination)}; ` +
        `openings stored ${shared} and ${later}`,
    }];
  });

  await o6m6Rows([labels.openingClear], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    await o6m6Movement(tx, { to: f.shared }, O6M6_MID, f.income);
    const onTheDay = await m1Refusal(tx, (sp) =>
      sp`update accounts set initial_balance_on = ${O6M6_MID} where id = ${f.shared}`);
    const earlier = await m1Refusal(tx, (sp) =>
      sp`update accounts set initial_balance_on = '2026-03-01' where id = ${f.shared}`);
    const empty = await m1Refusal(tx, (sp) =>
      sp`update accounts set initial_balance_on = '2026-05-01' where id = ${f.later}`);
    // An account already past one of its movements, edited the way `updateAccount` writes: every column, the
    // unchanged opening among them; and a rename alone.
    await o6m6Predate(tx, f.shared, O6M6_LATER_OPEN);
    await enterUserContext(tx, f.member);
    const form = await m1Refusal(tx, (sp) =>
      sp`update accounts set name = 'rls o6m6 renamed', initial_balance_on = ${O6M6_LATER_OPEN} where id = ${f.shared}`);
    const rename = await m1Refusal(tx, (sp) =>
      sp`update accounts set name = 'rls o6m6 renamed again' where id = ${f.shared}`);
    const [{ day, name }] = await tx<{ day: string; name: string }[]>`
      select initial_balance_on::text as day, name from accounts where id = ${f.shared}`;
    return [{
      ok: onTheDay === null && earlier === null && empty === null && form === null && rename === null &&
        day === O6M6_LATER_OPEN && name === "rls o6m6 renamed again",
      detail: `income on ${O6M6_MID}: opening moved to that day ${o6m6Code(onTheDay)}, to 2026-03-01 ${o6m6Code(earlier)}; ` +
        `an account with no movement moved to 2026-05-01 ${o6m6Code(empty)}; an account already past its movement, ` +
        `the form re-sending its opening ${o6m6Code(form)}, a rename ${o6m6Code(rename)}; stored ${day}, «${name}»`,
    }];
  });

  await o6m6Rows([labels.adjustment], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const before = await m1Refusal(tx, (sp) =>
      sp`insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${f.shared}, ${O6M6_EVE}, 5000)`);
    const onTheDay = await m1Refusal(tx, (sp) =>
      sp`insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${f.shared}, ${O6M6_OPEN}, 5000)`);
    await tx`reset role`;
    const adjustments = await tx<{ day: string; amount: number }[]>`
      select occurred_at::text as day, amount_cents::int as amount from transactions
      where to_account_id = ${f.shared} and reconciliation_id is not null`;
    return [{
      ok: before === "RC002" && onTheDay === null && adjustments.length === 1 &&
        adjustments[0].day === O6M6_OPEN && adjustments[0].amount === 5000,
      detail: `counted on ${O6M6_EVE}: ${o6m6Code(before)}; counted on ${O6M6_OPEN}: ${o6m6Code(onTheDay)}, ` +
        `adjustments ${adjustments.map((a) => `${a.amount} on ${a.day}`).join(", ") || "none"}`,
    }];
  });

  await o6m6Rows([labels.underRls], async (tx) => {
    const f = await o6m6Fund(tx);
    await enterUserContext(tx, f.member);
    const [{ role }] = await tx<{ role: string }[]>`select current_user as role`;
    const insert = await o6m6Insert(tx, { from: f.shared }, O6M6_EVE, f.expense);
    await o6m6Movement(tx, { from: f.shared }, O6M6_MID, f.expense);
    const opening = await m1Refusal(tx, (sp) =>
      sp`update accounts set initial_balance_on = '2026-03-21' where id = ${f.shared}`);
    // The member's own account sends money to the fund; the transfer is the fund's. Once the member leaves, only the
    // guard reads that transfer, not the person moving their own account's opening.
    const [{ id: own }] = await tx<{ id: string }[]>`
      insert into accounts (owner_user_id, name, kind, initial_balance_on)
      values (${f.member}, 'rls o6m6 member cash', 'asset', ${O6M6_OPEN}) returning id`;
    await o6m6Movement(tx, { from: own, to: f.shared }, O6M6_MID, null);
    await tx`reset role`;
    await tx`update group_members set archived_at = now() where group_id = ${f.groupId} and user_id = ${f.member}`;
    await enterUserContext(tx, f.member);
    const [{ visible }] = await tx<{ visible: number }[]>`
      select count(*)::int as visible from transactions where from_account_id = ${own}`;
    const left = await m1Refusal(tx, (sp) =>
      sp`update accounts set initial_balance_on = '2026-03-21' where id = ${own}`);
    return [{
      ok: role === "authenticated" && insert === "MO001" && opening === "MO002" && visible === 0 && left === "MO002",
      detail: `as ${role}: a pre-opening expense ${o6m6Code(insert)}, the opening moved past a movement ${o6m6Code(opening)}; ` +
        `after leaving, the transfers out of their own account they read ${visible}, its opening moved past one ${o6m6Code(left)}`,
    }];
  });

  await o6m6Rows([labels.owner], async (tx) => {
    const f = await o6m6Fund(tx);
    await tx`reset role`;
    await tx`select set_config('request.jwt.claims', '', true)`;
    const code = await m1Refusal(tx, async (sp) => {
      const [{ id }] = await sp<{ id: string }[]>`
        insert into transactions (group_id, from_account_id, amount_cents, occurred_at, description, created_by)
        values (${f.groupId}, ${f.shared}, 1000, ${O6M6_EVE}, 'rls o6m6 nightly', ${f.leader}) returning id`;
      await sp`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${id}, ${f.expense}, 1000)`;
      await sp`set constraints all immediate`;
      await sp`set constraints all deferred`;
    });
    const [{ uid }] = await tx<{ uid: string | null }[]>`select auth.uid() as uid`;
    return [{
      ok: uid === null && code === "MO001",
      detail: `as the table owner, auth.uid() ${uid}, an expense dated ${O6M6_EVE}: ${o6m6Code(code)}`,
    }];
  });

  await o6m6Rows([labels.definer], async (tx) => {
    // The guards are whichever trigger functions on the two tables raise the new codes; the check is what the
    // executor enforces, read from the live catalog.
    const guards = await tx<{
      relation: string;
      fn: string;
      definer: boolean;
      config: string[] | null;
      grantees: string[];
    }[]>`
      select distinct c.relname as relation, p.oid::regprocedure::text as fn, p.prosecdef as definer,
        p.proconfig as config,
        array(select r from unnest(array['public', 'anon', 'authenticated', 'service_role']) r
          where (r = 'public' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
             or (r <> 'public' and has_function_privilege(r, p.oid, 'EXECUTE'))) as grantees
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      where n.nspname = 'finances' and c.relname in ('transactions', 'accounts') and not t.tgisinternal
        and ((c.relname = 'transactions' and p.prosrc like '%MO001%') or (c.relname = 'accounts' and p.prosrc like '%MO002%'))`;
    const shaped = (g: (typeof guards)[number]) =>
      g.definer && (g.config ?? []).some((c) => c === 'search_path=""' || c === "search_path=") && g.grantees.length === 0;
    const relations = new Set(guards.map((g) => g.relation));
    return [{
      ok: relations.has("transactions") && relations.has("accounts") && guards.every(shaped),
      detail: guards.length === 0 ? "no trigger on transactions raises MO001 and none on accounts raises MO002"
        : guards.map((g) => `${g.relation}: ${g.fn} definer ${g.definer}, config ${JSON.stringify(g.config)}, ` +
          `executable by ${g.grantees.join(", ") || "no API role"}`).join("; "),
    }];
  });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ groups, accounts, movements }] = await sql<{ groups: number; accounts: number; movements: number }[]>`
    select
      (select count(*)::int from groups where name like 'rls o6m6%') as groups,
      (select count(*)::int from accounts where name like 'rls o6m6%') as accounts,
      (select count(*)::int from transactions where description like 'rls o6m6%') as movements`;
  assert(
    labels.tail,
    afterUser === "postgres" && groups === 0 && accounts === 0 && movements === 0,
    `current_user = ${afterUser}, groups ${groups}, accounts ${accounts}, movements ${movements} named 'rls o6m6%'`,
  );
}

// Oleada 6's database survivors: a cancelled payment whose movement is deleted, a creator rewritten by UPDATE, both
// bounds of the opening guard on each leg, and a stranger's pre-opening movement. Every row rolls back.
const O7M11_DAY_AFTER_OPEN = "2026-03-11";

async function checkO7M11Survivors() {
  console.log("");
  const labels = {
    cancelled: "o7m11-1. a settled payment cancelled by hand keeps cancelled when its movement is deleted; only the link clears",
    creator: "o7m11-2. an UPDATE by a caller granted it cannot rewrite who planned the payment, with or without claims",
    fromOnOpen: "o7m11-3. an expense dated on its account's opening day stops the opening moving one day later, with MO002",
    toOnOpen: "o7m11-4. an income dated on its account's opening day stops the opening moving one day later, with MO002",
    fromToDay: "o7m11-5. moving an opening to exactly an expense's day saves",
    toToDay: "o7m11-6. moving an opening to exactly an income's day saves",
    stranger: "o7m11-7. a stranger naming another fund's account in a pre-opening movement gets the policy's 42501, not MO001",
    tail: "o7m11-8. the rolled-back o7m11 transactions leave no fixture behind",
  };

  await m1Rows([labels.cancelled], async (tx) => {
    const f = await o6m1Fund(tx);
    await enterUserContext(tx, f.leader);
    const cancel = await m1Refusal(tx, (sp) =>
      sp`update planned_payments set status = 'cancelled' where id = ${f.payment} and status = 'done'`);
    await tx`reset role`;
    const before = await o6m1bRead(tx, f.payment);
    await enterUserContext(tx, f.member);
    const deleteCode = await m1Refusal(tx, async (sp) => {
      await sp`delete from transactions where id = ${f.settling}`;
      await sp`set constraints all immediate`;
      await sp`set constraints all deferred`;
    });
    await tx`reset role`;
    const after = await o6m1bRead(tx, f.payment);
    const changed = o6m1bChanged(before, after);
    return [{
      ok: cancel === null && before?.status === "cancelled" && before.settled_transaction_id === f.settling &&
        deleteCode === null && after?.status === "cancelled" && after.settled_transaction_id === null && changed.length === 0,
      detail: `cancel ${o6m6Code(cancel)}, before the delete: status ${before?.status}, linked to the settling movement ` +
        `${before?.settled_transaction_id === f.settling}; delete ${o6m6Code(deleteCode)}; after: status ${after?.status}, ` +
        `link ${after?.settled_transaction_id ?? "null"}; other columns changed: ${changed.join(", ") || "none"}`,
    }];
  });

  await m1Rows([labels.creator], async (tx) => {
    const f = await o6m1Fund(tx);
    await enterUserContext(tx, f.leader);
    const [{ id: payment }] = await tx<{ id: string }[]>`
      insert into planned_payments (from_account_id, amount_cents, due_date, description)
      values (${f.shared}, 7000, ${todayInBogota()}, 'rls o7m11 payment') returning id`;
    // The table owner holds UPDATE on every column; the member's claims make auth.uid() someone else.
    await enterUserContext(tx, f.member);
    await tx`reset role`;
    const withClaims = await tx`update planned_payments
      set created_by = ${f.member}, description = 'rls o7m11 rewritten' where id = ${payment} returning id`;
    const [{ creator: afterClaims }] = await tx<{ creator: string | null }[]>`
      select created_by as creator from planned_payments where id = ${payment}`;
    await tx`select set_config('request.jwt.claims', '', true)`;
    const noClaims = await tx`update planned_payments
      set created_by = ${f.member}, description = 'rls o7m11 rewritten again' where id = ${payment} returning id`;
    const [{ creator: afterNoClaims, description }] = await tx<{ creator: string | null; description: string }[]>`
      select created_by as creator, description from planned_payments where id = ${payment}`;
    const who = (id: string | null) => (id === f.leader ? "the leader" : id === f.member ? "the member" : String(id));
    return [{
      ok: withClaims.length === 1 && noClaims.length === 1 && description === "rls o7m11 rewritten again" &&
        afterClaims === f.leader && afterNoClaims === f.leader,
      detail: `planned by the leader; set to the member with the member's claims (${withClaims.length} row): ${who(afterClaims)}; ` +
        `with no claims (${noClaims.length} row): ${who(afterNoClaims)}; description «${description}»`,
    }];
  });

  // Each leg alone in the account, so only the bound under test decides the verdict.
  const boundRow = async (
    label: string,
    leg: "from" | "to",
    movementDay: string,
    newOpening: string,
    expected: string | null,
  ) =>
    o6m6Rows([label], async (tx) => {
      const f = await o6m6Fund(tx);
      await enterUserContext(tx, f.member);
      await o6m6Movement(tx, leg === "from" ? { from: f.shared } : { to: f.shared }, movementDay,
        leg === "from" ? f.expense : f.income);
      const code = await m1Refusal(tx, (sp) =>
        sp`update accounts set initial_balance_on = ${newOpening} where id = ${f.shared}`);
      const opening = await o6m6Opening(tx, f.shared);
      return [{
        ok: code === expected && opening === (expected === null ? newOpening : O6M6_OPEN),
        detail: `${leg === "from" ? "an expense out of" : "an income into"} the account opened ${O6M6_OPEN}, dated ` +
          `${movementDay}; opening moved to ${newOpening}: ${o6m6Code(code)}, stored opening ${opening}`,
      }];
    });

  await boundRow(labels.fromOnOpen, "from", O6M6_OPEN, O7M11_DAY_AFTER_OPEN, "MO002");
  await boundRow(labels.toOnOpen, "to", O6M6_OPEN, O7M11_DAY_AFTER_OPEN, "MO002");
  await boundRow(labels.fromToDay, "from", O6M6_MID, O6M6_MID, null);
  await boundRow(labels.toToDay, "to", O6M6_MID, O6M6_MID, null);

  await o6m6Rows([labels.stranger], async (tx) => {
    const f = await o6m6Fund(tx);
    const stranger = randomUUID();
    await tx`insert into auth.users (id) values (${stranger})`;
    await tx`insert into app_users (id) values (${stranger})`;
    await enterUserContext(tx, stranger);
    const [{ role }] = await tx<{ role: string }[]>`select current_user as role`;
    const early = await m1Refusal(tx, (sp) =>
      sp`insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${f.shared}, 1000, ${O6M6_EVE}, 'rls o7m11 stranger') returning id`);
    const onTime = await m1Refusal(tx, (sp) =>
      sp`insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${f.shared}, 1000, ${O6M6_MID}, 'rls o7m11 stranger') returning id`);
    await tx`reset role`;
    const [{ n: stored }] = await tx<{ n: number }[]>`
      select count(*)::int as n from transactions where description = 'rls o7m11 stranger'`;
    return [{
      ok: role === "authenticated" && early === "42501" && onTime === "42501" && stored === 0,
      detail: `as ${role}, a stranger to the fund: an expense out of its account dated ${O6M6_EVE} ${o6m6Code(early)}, ` +
        `dated ${O6M6_MID} ${o6m6Code(onTime)}; rows stored ${stored}`,
    }];
  });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ payments, movements }] = await sql<{ payments: number; movements: number }[]>`
    select
      (select count(*)::int from planned_payments where description like 'rls o7m11%') as payments,
      (select count(*)::int from transactions where description like 'rls o7m11%') as movements`;
  assert(
    labels.tail,
    afterUser === "postgres" && payments === 0 && movements === 0,
    `current_user = ${afterUser}, payments ${payments}, movements ${movements} named 'rls o7m11%'`,
  );
}

// RF-155 and RF-45: a person marks a standing-out movement «Está bien» once per rule, the mark is final, readable
// by whoever reads the movement, written only by whoever may write it, and audited; quick entry flags an amount it
// read from words. Every row rolls back.
//
// O7M2_MIGRATION_FILE  a path to a SQL file; each row drops what 0072 made and installs that file instead, inside
//                      its own transaction, so a mutant never outlives the ROLLBACK.
// O7M2_ROW             runs only the row with that number, so a mutant meets the one row that kills it.
const O7M2_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

type O7m2Mark = { id: string; transaction_id: string; rule: string; marked_by: string; marked_at: string };

async function o7m2Rows(labels: string[], body: (tx: M1Tx) => Promise<M1Verdict[]>): Promise<void> {
  const only = process.env.O7M2_ROW;
  if (only && !labels.some((label) => label.startsWith(`o7m2-${only}.`))) return;
  let verdicts: M1Verdict[] = labels.map(() => ({ ok: false, detail: "the body never ran" }));
  await sql
    .begin(async (tx) => {
      const override = process.env.O7M2_MIGRATION_FILE;
      if (override) {
        await tx.unsafe(`drop table if exists finances.transaction_reviews cascade`);
        await tx.unsafe(`alter table finances.transactions drop column if exists amount_from_words`);
        await m1RunMigration(tx, override);
      }
      verdicts = await body(tx);
      throw M1_ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error === M1_ROLLBACK) return;
      verdicts = labels.map(() => ({ ok: false, detail: `aborted — ${describeRefusal(error)}` }));
    });
  labels.forEach((label, i) => assert(label, verdicts[i].ok, verdicts[i].detail));
}

// The member A owns a personal account and its movement; the leader reads it as a fund member; a shared account
// carries a movement the leader wrote. Leaves the role reset.
async function o7m2Fund(tx: M1Tx) {
  const f = await o6m1bFund(tx);
  await tx`update groups set name = 'rls o7m2' where id = ${f.groupId}`;
  await enterUserContext(tx, f.member);
  const personalMovement = await o6m1Movement(tx, f.personal, f.personalCategory, 4200, "rls o7m2 movement");
  await enterUserContext(tx, f.leader);
  const sharedMovement = await o6m1Movement(tx, f.shared, f.groupCategory, 5100, "rls o7m2 movement");
  await tx`reset role`;
  return { ...f, personalMovement, sharedMovement };
}

// A leader of a fund of their own, who reads nothing of the first. Leaves the role reset.
async function o7m2Stranger(tx: M1Tx): Promise<string> {
  const { leader } = await m1Group(tx);
  await tx`reset role`;
  return leader;
}

// Inserts one mark in the session's current role, naming only the granted columns.
async function o7m2Mark(tx: M1Tx, movement: string, rule: string): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    insert into transaction_reviews (transaction_id, rule) values (${movement}, ${rule}) returning id`;
  return id;
}

// The sqlstate a mark is refused with, or null when it saved.
async function o7m2Try(tx: M1Tx, movement: string, rule: string): Promise<string | null> {
  return m1Refusal(tx, (sp) => o7m2Mark(sp, movement, rule));
}

// Read as the table owner, so no policy hides a mark.
async function o7m2Stored(tx: M1Tx, movement: string): Promise<O7m2Mark[]> {
  return tx<O7m2Mark[]>`
    select id, transaction_id, rule, marked_by, marked_at::text as marked_at
    from finances.transaction_reviews where transaction_id = ${movement} order by rule`;
}

function o7m2Code(code: string | null): string {
  return code ?? "accepted";
}

async function checkTransactionReviews() {
  console.log("");
  const labels = {
    writer: "o7m2-1. the owner of a personal account marks its movement 'twin' and the mark is stored",
    reader: "o7m2-2. another member of the fund reads that mark",
    readerCannot: "o7m2-3. that member, who only reads the owner's personal movement, cannot mark it: 42501",
    shared: "o7m2-4. a plain member and the leader each mark a movement of a shared fund account",
    stranger: "o7m2-5. a user of another fund reads none of the fund's marks and cannot mark its movements: 42501",
    oncePerRule: "o7m2-6. a second 'twin' on one movement is 23505; a 'from_words' on it saves",
    ruleClosed: "o7m2-7. the four rules save and any other rule is 23514",
    final: "o7m2-8. the writer can update no mark; a fund member who only reads the movement deletes none; the writer's delete takes it (RF-163)",
    markedBy: "o7m2-9. naming marked_by is refused by the grant, even naming oneself; the stored one is auth.uid() at now()",
    cascade: "o7m2-10. deleting the movement deletes its marks",
    audit: "o7m2-11. a mark writes one INSERT row to audit_log naming transaction_reviews, the mark and its writer",
    grants: "o7m2-12. anon and service_role hold no privilege on transaction_reviews; authenticated holds select, insert (transaction_id, rule) and delete alone",
    column: "o7m2-13. amount_from_words is false when the insert omits it, true when it names true, and no update can name it",
    index: "o7m2-14. transaction_reviews carries an index led by marked_by",
    tail: "o7m2-15. the rolled-back o7m2 transactions leave no fixture behind",
  };

  await o7m2Rows([labels.writer, labels.reader, labels.readerCannot], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    const writeCode = await m1Refusal(tx, (sp) => o7m2Mark(sp, f.personalMovement, "twin"));
    await enterUserContext(tx, f.leader);
    const seen = await tx<{ id: string }[]>`
      select id from transaction_reviews where transaction_id = ${f.personalMovement}`;
    const [{ movements }] = await tx<{ movements: number }[]>`
      select count(*)::int as movements from transactions where id = ${f.personalMovement}`;
    const readerCode = await o7m2Try(tx, f.personalMovement, "above_usual");
    await tx`reset role`;
    const stored = await o7m2Stored(tx, f.personalMovement);
    return [
      {
        ok: writeCode === null && stored.filter((m) => m.rule === "twin").length === 1,
        detail: `A marks A's personal movement 'twin': ${o7m2Code(writeCode)}; stored 'twin' marks ${stored.filter((m) => m.rule === "twin").length}`,
      },
      {
        ok: movements === 1 && seen.length === 1,
        detail: `the leader reads the movement (${movements} row) and its marks: ${seen.length} row`,
      },
      {
        ok: movements === 1 && readerCode === "42501" && stored.every((m) => m.rule !== "above_usual"),
        detail: `the leader marks A's personal movement 'above_usual': ${o7m2Code(readerCode)}; stored rules ` +
          `[${stored.map((m) => m.rule).join(", ")}]`,
      },
    ];
  });

  await o7m2Rows([labels.shared], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    const memberCode = await o7m2Try(tx, f.sharedMovement, "twin");
    await enterUserContext(tx, f.leader);
    const leaderCode = await o7m2Try(tx, f.sharedMovement, "above_usual");
    await tx`reset role`;
    const stored = await o7m2Stored(tx, f.sharedMovement);
    const by = (rule: string) => stored.find((m) => m.rule === rule)?.marked_by;
    return [{
      ok: memberCode === null && leaderCode === null && stored.length === 2 &&
        by("twin") === f.member && by("above_usual") === f.leader,
      detail: `the leader's movement on the shared account: A marks 'twin' ${o7m2Code(memberCode)}, the leader marks ` +
        `'above_usual' ${o7m2Code(leaderCode)}; stored ${stored.length}, 'twin' by ${o6m1bWho(by("twin") ?? null, f)}, ` +
        `'above_usual' by ${o6m1bWho(by("above_usual") ?? null, f)}`,
    }];
  });

  await o7m2Rows([labels.stranger], async (tx) => {
    const f = await o7m2Fund(tx);
    const stranger = await o7m2Stranger(tx);
    await enterUserContext(tx, f.member);
    await o7m2Mark(tx, f.personalMovement, "twin");
    await enterUserContext(tx, f.leader);
    await o7m2Mark(tx, f.sharedMovement, "twin");
    await enterUserContext(tx, stranger);
    const [{ role }] = await tx<{ role: string }[]>`select current_user as role`;
    const seen = await tx<{ id: string }[]>`
      select id from transaction_reviews where transaction_id in (${f.personalMovement}, ${f.sharedMovement})`;
    const personalCode = await o7m2Try(tx, f.personalMovement, "above_usual");
    const sharedCode = await o7m2Try(tx, f.sharedMovement, "above_usual");
    await tx`reset role`;
    const stored = [...(await o7m2Stored(tx, f.personalMovement)), ...(await o7m2Stored(tx, f.sharedMovement))];
    return [{
      ok: role === "authenticated" && stored.length === 2 && seen.length === 0 &&
        personalCode === "42501" && sharedCode === "42501",
      detail: `as ${role}, a leader of another fund: reads ${seen.length} of the ${stored.length} stored marks; marks the ` +
        `personal movement ${o7m2Code(personalCode)}, the shared one ${o7m2Code(sharedCode)}`,
    }];
  });

  await o7m2Rows([labels.oncePerRule], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    const first = await o7m2Try(tx, f.personalMovement, "twin");
    const again = await o7m2Try(tx, f.personalMovement, "twin");
    const words = await o7m2Try(tx, f.personalMovement, "from_words");
    await tx`reset role`;
    const stored = await o7m2Stored(tx, f.personalMovement);
    return [{
      ok: first === null && again === "23505" && words === null &&
        stored.map((m) => m.rule).join(",") === "from_words,twin",
      detail: `'twin' ${o7m2Code(first)}, 'twin' again ${o7m2Code(again)}, 'from_words' ${o7m2Code(words)}; stored ` +
        `[${stored.map((m) => m.rule).join(", ")}]`,
    }];
  });

  await o7m2Rows([labels.ruleClosed], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    const known: string[] = [];
    for (const rule of REVIEW_RULES) known.push(`${rule} ${o7m2Code(await o7m2Try(tx, f.personalMovement, rule))}`);
    const other = await o7m2Try(tx, f.personalMovement, "other");
    const blank = await o7m2Try(tx, f.sharedMovement, "");
    await tx`reset role`;
    const stored = await o7m2Stored(tx, f.personalMovement);
    const shared = await o7m2Stored(tx, f.sharedMovement);
    return [{
      ok: known.every((entry) => entry.endsWith(" accepted")) && stored.length === 4 &&
        other === "23514" && blank === "23514" && shared.length === 0,
      detail: `${known.join(", ")}; 'other' ${o7m2Code(other)}; '' ${o7m2Code(blank)}; stored ${stored.length} + ${shared.length}`,
    }];
  });

  await o7m2Rows([labels.final], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    const id = await o7m2Mark(tx, f.personalMovement, "twin");
    await tx`reset role`;
    const [before] = await o7m2Stored(tx, f.personalMovement);
    await enterUserContext(tx, f.member);
    const outcome = async (run: (sp: M1Tx) => PromiseLike<readonly unknown[]>) => {
      let rows = -1;
      const code = await m1Refusal(tx, async (sp) => {
        rows = (await run(sp)).length;
      });
      return { ok: code === "42501" || (code === null && rows === 0), shown: code ?? `${rows} rows` };
    };
    const rule = await outcome((sp) => sp`update transaction_reviews set rule = 'from_words' where id = ${id} returning id`);
    const when = await outcome((sp) =>
      sp`update transaction_reviews set marked_at = now() - interval '1 day' where id = ${id} returning id`);
    await tx`reset role`;
    await enterUserContext(tx, f.leader);
    const readerGone = await outcome((sp) => sp`delete from transaction_reviews where id = ${id} returning id`);
    await tx`reset role`;
    const kept = await o7m2Stored(tx, f.personalMovement);
    await enterUserContext(tx, f.member);
    const taken = (await tx`delete from transaction_reviews where id = ${id} returning id`).length;
    await tx`reset role`;
    const after = await o7m2Stored(tx, f.personalMovement);
    const unchanged = kept.length === 1 && JSON.stringify(kept[0]) === JSON.stringify(before);
    return [{
      ok: rule.ok && when.ok && readerGone.ok && unchanged && taken === 1 && after.length === 0,
      detail: `as the writer: update rule ${rule.shown}, update marked_at ${when.shown}; as a reader: delete ${readerGone.shown}, ` +
        `mark ${unchanged ? "unchanged" : `now ${JSON.stringify(kept)}`}; the writer's delete took ${taken}, ${after.length} left`,
    }];
  });

  await o7m2Rows([labels.markedBy], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    const foreign = await m1Refusal(tx, (sp) =>
      sp`insert into transaction_reviews (transaction_id, rule, marked_by) values (${f.personalMovement}, 'twin', ${f.leader})`);
    const self = await m1Refusal(tx, (sp) =>
      sp`insert into transaction_reviews (transaction_id, rule, marked_by) values (${f.personalMovement}, 'from_words', ${f.member})`);
    const plain = await o7m2Try(tx, f.personalMovement, "above_usual");
    await tx`reset role`;
    const stored = await o7m2Stored(tx, f.personalMovement);
    const [{ now }] = await tx<{ now: string }[]>`select now()::text as now`;
    const mark = stored.find((m) => m.rule === "above_usual");
    return [{
      ok: foreign === "42501" && self === "42501" && plain === null && stored.length === 1 &&
        mark?.marked_by === f.member && mark.marked_at === now,
      detail: `A names the leader as marked_by: ${o7m2Code(foreign)}; names itself: ${o7m2Code(self)}; names neither: ` +
        `${o7m2Code(plain)}; stored [${stored.map((m) => `${m.rule} by ${o6m1bWho(m.marked_by, f)} at ${m.marked_at}`).join("; ")}], now ${now}`,
    }];
  });

  await o7m2Rows([labels.cascade], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    await o7m2Mark(tx, f.personalMovement, "twin");
    await o7m2Mark(tx, f.personalMovement, "from_words");
    await tx`reset role`;
    const before = (await o7m2Stored(tx, f.personalMovement)).length;
    await enterUserContext(tx, f.member);
    const code = await m1Refusal(tx, async (sp) => {
      await sp`delete from transactions where id = ${f.personalMovement}`;
      await sp`set constraints all immediate`;
      await sp`set constraints all deferred`;
    });
    await tx`reset role`;
    const after = (await o7m2Stored(tx, f.personalMovement)).length;
    const [{ movements }] = await tx<{ movements: number }[]>`
      select count(*)::int as movements from transactions where id = ${f.personalMovement}`;
    return [{
      ok: before === 2 && code === null && movements === 0 && after === 0,
      detail: `${before} marks; A deletes the movement: ${o7m2Code(code)}; movement rows ${movements}, marks left ${after}`,
    }];
  });

  await o7m2Rows([labels.audit], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    const id = await o7m2Mark(tx, f.personalMovement, "twin");
    await tx`reset role`;
    const rows = await tx<{ action: string; actor_user_id: string | null; rule: string | null }[]>`
      select action, actor_user_id, after_data->>'rule' as rule
      from audit_log where entity = 'transaction_reviews' and record_id = ${id}`;
    return [{
      ok: rows.length === 1 && rows[0].action === "INSERT" && rows[0].actor_user_id === f.member && rows[0].rule === "twin",
      detail: `audit rows for the mark: ${rows.length}` +
        (rows.length ? ` — ${rows.map((r) => `${r.action} by ${o6m1bWho(r.actor_user_id, f)}, rule ${r.rule}`).join("; ")}` : ""),
    }];
  });

  await o7m2Rows([labels.grants], async (tx) => {
    const held = await tx<{ role: string; privilege: string }[]>`
      select r.role, p.privilege
      from unnest(array['anon', 'service_role']) as r(role)
      cross join unnest(${O7M2_PRIVILEGES as unknown as string[]}::text[]) as p(privilege)
      where has_table_privilege(r.role, 'finances.transaction_reviews', p.privilege)
         or (p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
             and has_any_column_privilege(r.role, 'finances.transaction_reviews', p.privilege))`;
    const [mine] = await tx<{ select_all: boolean; table_insert: boolean; any_update: boolean; del: boolean; trunc: boolean }[]>`
      select
        has_table_privilege('authenticated', 'finances.transaction_reviews', 'SELECT') as select_all,
        has_table_privilege('authenticated', 'finances.transaction_reviews', 'INSERT') as table_insert,
        has_any_column_privilege('authenticated', 'finances.transaction_reviews', 'UPDATE') as any_update,
        has_table_privilege('authenticated', 'finances.transaction_reviews', 'DELETE') as del,
        has_table_privilege('authenticated', 'finances.transaction_reviews', 'TRUNCATE') as trunc`;
    const insertable = await tx<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'finances' and table_name = 'transaction_reviews'
        and has_column_privilege('authenticated', 'finances.transaction_reviews', column_name, 'INSERT')
      order by column_name`;
    const driven: string[] = [];
    for (const role of ["anon", "service_role"] as const) {
      await m1Become(tx, role, randomUUID());
      driven.push(`${role} select ${o7m2Code(await m1Refusal(tx, (sp) => sp`select id from finances.transaction_reviews limit 1`))}`);
      await tx`reset role`;
    }
    const insertColumns = insertable.map((c) => c.column_name).join(",");
    return [{
      ok: held.length === 0 && driven.every((entry) => entry.endsWith(" 42501")) && mine.select_all && !mine.table_insert &&
        !mine.any_update && mine.del && !mine.trunc && insertColumns === "rule,transaction_id",
      detail: `anon/service_role hold [${held.map((h) => `${h.role} ${h.privilege}`).join(", ")}]; ${driven.join(", ")}; ` +
        `authenticated: select ${mine.select_all}, table insert ${mine.table_insert}, insert columns [${insertColumns}], ` +
        `any update ${mine.any_update}, delete ${mine.del}, truncate ${mine.trunc}`,
    }];
  });

  await o7m2Rows([labels.column], async (tx) => {
    const f = await o7m2Fund(tx);
    await enterUserContext(tx, f.member);
    const [{ id: omitted }] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${f.personal}, 3000, ${todayInBogota()}, 'rls o7m2 movement') returning id`;
    await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${omitted}, ${f.personalCategory}, 3000)`;
    const [{ id: worded }] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description, amount_from_words)
      values (${f.personal}, 300000, ${todayInBogota()}, 'rls o7m2 movement', true) returning id`;
    await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${worded}, ${f.personalCategory}, 300000)`;
    const nulled = await m1Refusal(tx, (sp) =>
      sp`insert into transactions (from_account_id, amount_cents, occurred_at, description, amount_from_words)
        values (${f.personal}, 3000, ${todayInBogota()}, 'rls o7m2 movement', null)`);
    const raise = await m1Refusal(tx, (sp) => sp`update transactions set amount_from_words = true where id = ${omitted}`);
    const lower = await m1Refusal(tx, (sp) => sp`update transactions set amount_from_words = false where id = ${worded}`);
    const description = await m1Refusal(tx, (sp) =>
      sp`update transactions set description = 'rls o7m2 movement edited' where id = ${worded}`);
    await tx`reset role`;
    const stored = await tx<{ id: string; amount_from_words: boolean | null }[]>`
      select id, amount_from_words from finances.transactions where id in (${omitted}, ${worded})`;
    const flag = (id: string) => stored.find((row) => row.id === id)?.amount_from_words;
    return [{
      ok: flag(omitted) === false && flag(worded) === true && nulled === "23502" &&
        raise === "42501" && lower === "42501" && description === null,
      detail: `as A: omitted → ${flag(omitted)}, named true → ${flag(worded)}, named null ${o7m2Code(nulled)}; ` +
        `update to true ${o7m2Code(raise)}, to false ${o7m2Code(lower)}; the same update of the description ${o7m2Code(description)}`,
    }];
  });

  await o7m2Rows([labels.index], async (tx) => {
    const indexes = await tx<{ name: string; lead: string }[]>`
      select c.relname as name, a.attname as lead
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = 'finances.transaction_reviews'::regclass`;
    return [{
      ok: indexes.some((index) => index.lead === "marked_by"),
      detail: `indexes: [${indexes.map((index) => `${index.name} on ${index.lead}…`).join(", ")}]`,
    }];
  });

  const [{ current_user: afterUser }] = await sql<{ current_user: string }[]>`select current_user`;
  const [{ groups, movements }] = await sql<{ groups: number; movements: number }[]>`
    select
      (select count(*)::int from groups where name = 'rls o7m2') as groups,
      (select count(*)::int from transactions where description like 'rls o7m2%') as movements`;
  assert(
    labels.tail,
    afterUser === "postgres" && groups === 0 && movements === 0,
    `current_user = ${afterUser}, groups ${groups}, movements ${movements} named 'rls o7m2%'`,
  );
}

// Wrapped in an async IIFE (not top-level await) so the runner can transpile
// this to CJS and run it on any Node version, not only Node 22's native strip.
void (async () => {
  try {
    await main();
  } catch (error) {
    console.error("FAIL  the check aborted —", error);
    failed = true;
  } finally {
    await closeRun(sql);
    await sql.end();
  }

  process.exit(failed ? 1 : 0);
})();
