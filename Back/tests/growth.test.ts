import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate } from "../src/db.js";
import { readBundle, importBundle } from "../src/imports.js";
import { seedDemoAccounts, type User } from "../src/auth.js";
import { buildRoadmap, simulateEffects, handleGrowth } from "../src/growth.js";
import type { CareerEvent, CareerProfile } from "../src/career.js";
import { HttpError, type RouteContext } from "../src/http.js";

const fixtureProfile: CareerProfile = {
  employee: {
    id: "TEST",
    name: "Test",
    role: "Developer",
    grade: "Junior",
    department: "IT",
    managerId: null,
    lastReviewDate: "2026-09-01",
  },
  asOfDate: "2026-10-01",
  goal: { targetRole: "Developer", targetGrade: "Middle", inferred: true },
  baselineLevels: { A: 0, B: 0, C: 0 },
  effectiveLevels: { A: 0, B: 0, C: 0 },
  requirements: [{ skillId: "C", requiredLevel: 2, isCritical: true }],
  skills: [],
  history: [],
  changes: [],
  progress: {
    requiredPoints: 2,
    achievedPoints: 0,
    gapPoints: 2,
    percent: 0,
    criticalGaps: 1,
  },
};
const event = (
  id: string,
  skill: string,
  prerequisites: CareerEvent["prerequisites"] = [],
): CareerEvent => ({
  eventId: id,
  title: id,
  description: "",
  type: "course",
  format: "self_paced",
  durationHours: 2,
  mandatory: false,
  isActive: true,
  targetRoles: ["Developer"],
  targetGrades: ["Junior"],
  effects: [{ skillId: skill, gain: 2, maxLevel: 3 }],
  prerequisites,
  sessions: [],
});

test("simulation caps gains without reducing existing skills and leaves source untouched", () => {
  const levels = { A: 5, B: 1 };
  const result = simulateEffects(levels, [
    { skillId: "A", gain: 1, maxLevel: 3 },
    { skillId: "B", gain: 4, maxLevel: 3 },
  ]);
  assert.deepEqual(result.levels, { A: 5, B: 3 });
  assert.deepEqual(levels, { A: 5, B: 1 });
  assert.equal(result.gains.length, 1);
});
test("roadmap unlocks multiple prerequisite levels in order without mandatory activities", () => {
  const events = [
    event("C", "C", [{ skillId: "B", minLevel: 2 }]),
    event("B", "B", [{ skillId: "A", minLevel: 2 }]),
    event("A", "A"),
    { ...event("MANDATORY", "C"), mandatory: true },
  ];
  const plan = buildRoadmap(
    fixtureProfile,
    events,
    fixtureProfile.requirements,
    { weeklyHours: 4, formats: ["online"] },
    30,
  );
  assert.deepEqual(
    plan.steps.map((s) => s.eventId),
    ["A", "B", "C"],
  );
  assert.equal(plan.unmetRequirements.length, 0);
  assert.equal(plan.totalHours, 6);
  assert.ok(plan.steps[0]!.scheduledDate < plan.steps[1]!.scheduledDate);
  assert.deepEqual(fixtureProfile.effectiveLevels, { A: 0, B: 0, C: 0 });
});
test("roadmap respects weekly budget, future sessions and capacity", () => {
  const full = {
    ...event("FULL", "C"),
    format: "online",
    sessions: [
      { id: randomUUID(), date: "2026-10-10", capacity: 1, occupied: 1 },
    ],
  };
  const late = {
    ...event("LATE", "C"),
    format: "online",
    sessions: [
      { id: randomUUID(), date: "2027-01-01", capacity: null, occupied: 0 },
    ],
  };
  const expensive = { ...event("EXPENSIVE", "C"), durationHours: 30 };
  assert.equal(
    buildRoadmap(
      fixtureProfile,
      [full, late, expensive],
      fixtureProfile.requirements,
      { weeklyHours: 1, formats: ["online"] },
      30,
    ).steps.length,
    0,
  );
  const future = {
    ...full,
    eventId: "AVAILABLE",
    sessions: [
      { id: randomUUID(), date: "2026-10-10", capacity: 2, occupied: 1 },
    ],
  };
  assert.equal(
    buildRoadmap(
      fixtureProfile,
      [future],
      fixtureProfile.requirements,
      { weeklyHours: 4, formats: ["online"] },
      30,
    ).steps[0]?.scheduledDate,
    "2026-10-10",
  );
});
test("format preference breaks otherwise equal choices", () => {
  const online = {
    ...event("Z", "C"),
    format: "online",
    sessions: [
      { id: randomUUID(), date: "2026-10-10", capacity: null, occupied: 0 },
    ],
  };
  assert.equal(
    buildRoadmap(
      fixtureProfile,
      [event("A", "C"), online],
      fixtureProfile.requirements,
      { weeklyHours: 4, formats: ["online"] },
      30,
    ).steps[0]?.eventId,
    "Z",
  );
});

test(
  "growth PostgreSQL authorization, persistence and concurrency",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = `growth_${randomUUID().replaceAll("-", "")}`;
    const admin = createPool(url.toString());
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = createPool(url.toString());
    try {
      await migrate(pool);
      await importBundle(pool, await readBundle("./data"), { commit: true });
      await seedDemoAccounts(pool);
      const accounts = (
        await pool.query(
          'SELECT id,login,display_name AS "displayName",app_role AS role,employee_id AS "employeeId",demo_only AS demo FROM user_accounts',
        )
      ).rows as User[];
      const employee = accounts.find((u) => u.role === "employee")!;
      const administrator = accounts.find((u) => u.role === "admin")!;
      const manager = accounts.find((u) => u.role === "manager")!;
      const ids = (
        await pool.query(
          "SELECT employee_id FROM employees WHERE employee_id<>$1 AND employee_id<>$2 ORDER BY employee_id LIMIT 4",
          [employee.employeeId, manager.employeeId],
        )
      ).rows.map((r) => r.employee_id as string);
      const other: User = {
        ...employee,
        id: randomUUID(),
        employeeId: ids[0]!,
        login: "growth.other",
      };
      const third: User = {
        ...employee,
        id: randomUUID(),
        employeeId: ids[1]!,
        login: "growth.third",
      };
      for (const u of [other, third])
        await pool.query(
          "INSERT INTO user_accounts(id,employee_id,app_role,login,display_name,demo_only) VALUES($1,$2,$3,$4,$5,true)",
          [u.id, u.employeeId, u.role, u.login, "Growth test"],
        );
      const call = async (
        user: User,
        path: string,
        method = "GET",
        payload: unknown = {},
        key = randomUUID(),
      ) => {
        let data: any;
        let status = 200;
        const full = `/api/v1${path}`;
        const url = new URL(`http://localhost${full}`);
        const ctx = {
          pool,
          user,
          path: url.pathname,
          method,
          url,
          config: {
            databaseUrl: url.toString(),
            port: 0,
            origin: "http://localhost",
            demo: true,
            secure: false,
            datasetPath: "./data",
          },
          req: { headers: { "idempotency-key": key } },
          requestId: randomUUID(),
          body: async () => payload,
          send: (value: unknown, code?: number) => {
            data = value;
            status = code ?? 200;
          },
        } as unknown as RouteContext;
        assert.equal(await handleGrowth(ctx), true, `${method} ${path}`);
        return { data, status };
      };
      const denied = (promise: Promise<unknown>, status: number) =>
        assert.rejects(
          promise,
          (e) => e instanceof HttpError && e.status === status,
        );
      await t.test("preferences validate and remain private", async () => {
        assert.equal(
          (await call(employee, "/me/preferences")).data.weeklyHours,
          4,
        );
        await call(employee, "/me/preferences", "PUT", {
          weeklyHours: 6,
          formats: ["online", "self_paced"],
        });
        assert.equal(
          (await call(employee, "/me/preferences")).data.weeklyHours,
          6,
        );
        assert.equal(
          (await call(other, "/me/preferences")).data.weeklyHours,
          4,
        );
        await denied(call(administrator, "/me/preferences"), 403);
      });
      await t.test(
        "persisted plans are idempotent, private and versioned",
        async () => {
          const key = randomUUID();
          const first = await call(
            employee,
            "/me/plans",
            "POST",
            { horizonDays: 90 },
            key,
          );
          const duplicate = await call(
            employee,
            "/me/plans",
            "POST",
            { horizonDays: 90 },
            key,
          );
          assert.equal(first.data.id, duplicate.data.id);
          assert.equal(first.data.requiresRefresh, false);
          await denied(call(other, `/me/plans/${first.data.id}`), 404);
          const regenerated = await call(
            employee,
            `/me/plans/${first.data.id}/regenerate`,
            "POST",
            { expectedVersion: 1 },
          );
          assert.equal(regenerated.data.version, 2);
          await denied(
            call(employee, `/me/plans/${first.data.id}/archive`, "POST", {
              expectedVersion: 1,
            }),
            409,
          );
          assert.equal(
            (
              await call(
                employee,
                `/me/plans/${first.data.id}/archive`,
                "POST",
                { expectedVersion: 2 },
              )
            ).data.status,
            "archived",
          );
        },
      );
      await t.test("goal comparison never records completions", async () => {
        const count = (await pool.query("SELECT count(*) FROM participations"))
          .rows[0].count;
        const profiles = (
          await pool.query(
            'SELECT role AS "targetRole",grade AS "targetGrade" FROM role_profiles LIMIT 2',
          )
        ).rows;
        const compared = await call(employee, "/me/growth/compare", "POST", {
          goals: profiles,
          horizonDays: 30,
        });
        assert.equal(compared.data.length, 2);
        assert.equal(
          (await pool.query("SELECT count(*) FROM participations")).rows[0]
            .count,
          count,
        );
      });
      await t.test(
        "simulation API checks ordered prerequisites without changing history",
        async () => {
          const profile = (
            await pool.query(
              "SELECT role,grade FROM employees WHERE employee_id=$1",
              [employee.employeeId],
            )
          ).rows[0];
          for (const skill of ["GROWTH_A", "GROWTH_B"])
            await pool.query(
              "INSERT INTO skills VALUES($1,$1,'hard','test','Synthetic test skill')",
              [skill],
            );
          for (const [eventId, skill] of [
            ["GROWTH_FIRST", "GROWTH_A"],
            ["GROWTH_NEXT", "GROWTH_B"],
          ]) {
            await pool.query(
              "INSERT INTO events(event_id,title,description,type,format,duration_hours,mandatory) VALUES($1,$1,'Synthetic test event','course','self_paced',2,false)",
              [eventId],
            );
            await pool.query("INSERT INTO event_target_roles VALUES($1,$2)", [
              eventId,
              profile.role,
            ]);
            await pool.query("INSERT INTO event_target_grades VALUES($1,$2)", [
              eventId,
              profile.grade,
            ]);
            await pool.query(
              "INSERT INTO event_skill_effects VALUES($1,$2,2,3)",
              [eventId, skill],
            );
          }
          await pool.query(
            "INSERT INTO event_prerequisites VALUES('GROWTH_NEXT','GROWTH_A',2)",
          );
          await denied(
            call(employee, "/me/growth/simulate", "POST", {
              eventIds: ["GROWTH_NEXT"],
            }),
            409,
          );
          const result = await call(employee, "/me/growth/simulate", "POST", {
            eventIds: ["GROWTH_FIRST", "GROWTH_NEXT"],
          });
          assert.equal(result.data.projectedLevels.GROWTH_A, 2);
          assert.equal(result.data.projectedLevels.GROWTH_B, 2);
          assert.equal(result.data.persisted, false);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM participations WHERE event_id LIKE 'GROWTH%'",
              )
            ).rows[0].n,
            0,
          );
          const task = await call(employee, "/me/tasks", "POST", {
            title: "Практика навыка",
            skillId: "GROWTH_A",
            targetLevel: 2,
          });
          await denied(
            call(employee, `/me/tasks/${task.data.id}`, "PATCH", {
              status: "completed",
            }),
            409,
          );
        },
      );
      await t.test(
        "mentor opt-in requires approval and concurrent acceptance respects capacity",
        async () => {
          const skill = (
            await pool.query("SELECT skill_id FROM skills LIMIT 1")
          ).rows[0].skill_id;
          await call(employee, "/mentors/me", "PUT", {
            headline: "Ментор для теста",
            skillIds: [skill],
            capacity: 1,
            enabled: true,
          });
          assert.equal((await call(other, "/mentors")).data.length, 0);
          await denied(
            call(other, `/admin/mentors/${employee.employeeId}`, "PATCH", {
              approved: true,
            }),
            403,
          );
          await call(
            administrator,
            `/admin/mentors/${employee.employeeId}`,
            "PATCH",
            { approved: true },
          );
          assert.equal((await call(other, "/mentors")).data.length, 1);
          const a = await call(other, "/me/mentorships", "POST", {
            mentorId: employee.employeeId,
            message: "Первый запрос",
          });
          const b = await call(third, "/me/mentorships", "POST", {
            mentorId: employee.employeeId,
            message: "Второй запрос",
          });
          await denied(
            call(other, `/me/mentorships/${a.data.id}`, "PATCH", {
              status: "accepted",
            }),
            403,
          );
          const results = await Promise.allSettled([
            call(employee, `/me/mentorships/${a.data.id}`, "PATCH", {
              status: "accepted",
            }),
            call(employee, `/me/mentorships/${b.data.id}`, "PATCH", {
              status: "accepted",
            }),
          ]);
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM mentorship_requests WHERE status='accepted'",
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        "recognition stays private, recipient controls it and moderation requires report",
        async () => {
          const sent = await call(employee, "/me/recognitions", "POST", {
            recipientId: other.employeeId,
            message: "Спасибо за помощь",
          });
          assert.equal((await call(third, "/me/recognitions")).data.length, 0);
          await denied(
            call(employee, `/me/recognitions/${sent.data.id}`, "PATCH", {
              status: "accepted",
            }),
            409,
          );
          await call(other, `/me/recognitions/${sent.data.id}`, "PATCH", {
            status: "reported",
          });
          assert.equal(
            (await call(administrator, "/admin/recognitions")).data.length,
            1,
          );
          await call(
            administrator,
            `/admin/recognitions/${sent.data.id}`,
            "PATCH",
            { note: "Скрыто по просьбе получателя" },
          );
          assert.equal((await call(other, "/me/recognitions")).data.length, 0);
        },
      );
      await t.test(
        "personal tasks and achievements do not create points",
        async () => {
          const task = await call(employee, "/me/tasks", "POST", {
            title: "Обсудить цель с руководителем",
          });
          await denied(
            call(other, `/me/tasks/${task.data.id}`, "PATCH", {
              status: "completed",
            }),
            404,
          );
          assert.equal(
            (
              await call(employee, `/me/tasks/${task.data.id}`, "PATCH", {
                status: "completed",
              })
            ).data.pointsAwarded,
            0,
          );
          assert.equal(
            (await call(employee, "/me/achievements")).data.visibility,
            "private",
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM reward_ledger"))
              .rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "team challenges prohibit compulsory activities and expose no member ranking",
        async () => {
          const mandatory = (
            await pool.query(
              "SELECT event_id FROM events WHERE mandatory LIMIT 1",
            )
          ).rows[0].event_id;
          const voluntary = (
            await pool.query(
              "SELECT event_id FROM events WHERE NOT mandatory LIMIT 1",
            )
          ).rows[0].event_id;
          const input = {
            title: "Учимся вместе",
            description: "Добровольная учебная активность",
            startsOn: "2026-10-01",
            endsOn: "2026-11-01",
            eventIds: [mandatory],
          };
          await denied(call(employee, "/team-challenges", "POST", input), 403);
          await denied(
            call(administrator, "/team-challenges", "POST", input),
            400,
          );
          const challenge = await call(
            administrator,
            "/team-challenges",
            "POST",
            { ...input, eventIds: [voluntary] },
          );
          await call(
            employee,
            `/team-challenges/${challenge.data.id}/join`,
            "POST",
          );
          const rows = (await call(employee, "/team-challenges")).data;
          assert.equal(rows[0].memberCount, 1);
          assert.equal(rows[0].joined, true);
          assert.equal(rows[0].members, undefined);
          assert.equal(rows[0].ranking, undefined);
        },
      );
      await t.test(
        "rewards disabled by default; only administrator can enable rules",
        async () => {
          assert.equal(
            (await call(employee, "/me/rewards")).data.enabled,
            false,
          );
          assert.deepEqual((await call(employee, "/rewards/catalog")).data, []);
          const rules = {
            enabled: true,
            pointsPerEvent: 10,
            monthlyCap: 20,
            rulesText:
              "10 баллов за добровольное обучение; один раз за мероприятие.",
          };
          await denied(
            call(employee, "/admin/rewards/policy", "PUT", rules),
            403,
          );
          await call(administrator, "/admin/rewards/policy", "PUT", rules);
          assert.equal(
            (await call(employee, "/me/rewards/sync", "POST", {})).data.balance,
            0,
            "historical imported records do not earn points",
          );
        },
      );
      let earnedIds: string[] = [];
      await t.test(
        "concurrent sync earns once and excludes mandatory completions and monthly excess",
        async () => {
          const events = (
            await pool.query(
              "SELECT event_id FROM events WHERE NOT mandatory ORDER BY event_id LIMIT 3",
            )
          ).rows;
          for (const e of events) {
            const r = (
              await pool.query(
                "INSERT INTO participations(employee_id,event_id,date,status,completion_pct,assigned_by) VALUES($1,$2,'2026-10-01','completed',100,'self') RETURNING id",
                [employee.employeeId, e.event_id],
              )
            ).rows[0];
            earnedIds.push(r.id);
          }
          const mandatory = (
            await pool.query(
              "SELECT event_id FROM events WHERE mandatory LIMIT 1",
            )
          ).rows[0].event_id;
          await pool.query(
            "INSERT INTO participations(employee_id,event_id,date,status,completion_pct,assigned_by) VALUES($1,$2,'2026-10-01','completed',100,'hr')",
            [employee.employeeId, mandatory],
          );
          const results = await Promise.all([
            call(employee, "/me/rewards/sync", "POST", {}),
            call(employee, "/me/rewards/sync", "POST", {}),
          ]);
          assert.ok(results.every((r) => r.data.balance === 20));
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM reward_ledger WHERE kind='earned'",
              )
            ).rows[0].n,
            2,
          );
        },
      );
      await t.test(
        "parallel redemptions cannot double-spend; cancellation refunds once",
        async () => {
          const catalog = await call(
            administrator,
            "/admin/rewards/catalog",
            "POST",
            {
              title: "Демо-награда",
              description: "Нематериальная демонстрационная награда",
              cost: 15,
              stock: 2,
            },
          );
          const results = await Promise.allSettled([
            call(employee, "/me/rewards/redeem", "POST", {
              rewardId: catalog.data.id,
            }),
            call(employee, "/me/rewards/redeem", "POST", {
              rewardId: catalog.data.id,
            }),
          ]);
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal((await call(employee, "/me/rewards")).data.balance, 5);
          const success = results.find((r) => r.status === "fulfilled");
          assert.ok(success && success.status === "fulfilled");
          const id = success.value.data.id;
          await denied(
            call(other, `/me/rewards/redemptions/${id}`, "PATCH", {
              status: "cancelled",
            }),
            404,
          );
          await Promise.all([
            call(employee, `/me/rewards/redemptions/${id}`, "PATCH", {
              status: "cancelled",
            }),
            call(employee, `/me/rewards/redemptions/${id}`, "PATCH", {
              status: "cancelled",
            }),
          ]);
          assert.equal((await call(employee, "/me/rewards")).data.balance, 20);
          assert.equal(
            (
              await pool.query("SELECT stock FROM reward_catalog WHERE id=$1", [
                catalog.data.id,
              ])
            ).rows[0].stock,
            2,
          );
        },
      );
      await t.test(
        "corrected completion reverses its award once and cannot award again",
        async () => {
          const awarded = (
            await pool.query(
              "SELECT participation_id FROM reward_ledger WHERE kind='earned' LIMIT 1",
            )
          ).rows[0].participation_id;
          await pool.query(
            "UPDATE participations SET status='dropped',completion_pct=0 WHERE id=$1",
            [awarded],
          );
          await call(employee, "/me/rewards/sync", "POST", {});
          await call(employee, "/me/rewards/sync", "POST", {});
          assert.equal((await call(employee, "/me/rewards")).data.balance, 10);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM reward_ledger WHERE kind='reversed'",
              )
            ).rows[0].n,
            1,
          );
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
