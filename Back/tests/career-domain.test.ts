import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEffects,
  deriveLevels,
  progressFor,
} from "../src/career-domain.js";
import {
  eligibility,
  type CareerEvent,
  type CareerProfile,
} from "../src/career.js";

test("effects never lower an assessed skill and cap gains at five", () => {
  assert.deepEqual(
    applyEffects({ SQL: 5, API: 2 }, [
      { skillId: "SQL", gain: 2, maxLevel: 3 },
      { skillId: "API", gain: 4, maxLevel: 4 },
      { skillId: "NEW", gain: 1, maxLevel: 2 },
    ]),
    { SQL: 5, API: 4, NEW: 1 },
  );
});
test("assessment includes same-date completion; only later completed records alter skills", () => {
  const effects = [{ skillId: "SQL", gain: 1, maxLevel: 5 }];
  const history = [
    { id: "1", eventId: "e", date: "2026-09-01", status: "completed", effects },
    { id: "2", eventId: "e", date: "2026-09-02", status: "completed", effects },
    { id: "3", eventId: "e", date: "2026-09-03", status: "dropped", effects },
    { id: "4", eventId: "e", date: "2026-11-01", status: "completed", effects },
  ];
  const result = deriveLevels({ SQL: 2 }, "2026-09-01", "2026-10-01", history);
  assert.equal(result.levels.SQL, 3);
  assert.deepEqual(
    result.changes.map((x) => x.participationId),
    ["2"],
  );
  assert.equal(
    deriveLevels(
      { SQL: 2 },
      "2026-09-01",
      "2026-10-01",
      history.map((p) => ({ ...p, status: "dropped" })),
    ).levels.SQL,
    2,
  );
});
test("progress is requirement weighted and empty goal stays explicit", () => {
  assert.deepEqual(
    progressFor({ A: 5, B: 1 }, [
      { skillId: "A", requiredLevel: 3, isCritical: false },
      { skillId: "B", requiredLevel: 3, isCritical: true },
    ]),
    {
      requiredPoints: 6,
      achievedPoints: 4,
      gapPoints: 2,
      percent: 67,
      criticalGaps: 1,
    },
  );
  assert.equal(progressFor({}, []).percent, null);
});
const event: CareerEvent = {
  eventId: "EV_TEST",
  title: "Test",
  description: "",
  type: "course",
  format: "self_paced",
  durationHours: 2,
  mandatory: false,
  isActive: true,
  targetRoles: ["Engineer"],
  targetGrades: ["Junior"],
  effects: [{ skillId: "SQL", gain: 1, maxLevel: 5 }],
  prerequisites: [],
  sessions: [],
};
const profile = {
  employee: { id: "ARBITRARY_ID", role: "Engineer", grade: "Junior" },
  asOfDate: "2026-10-01",
  effectiveLevels: { SQL: 1 },
  history: [],
} as unknown as CareerProfile;
test("eligibility checks actual role, grade and prerequisites, self paced needs no session", () => {
  assert.equal(eligibility(event, profile).eligible, true);
  assert.deepEqual(
    eligibility(
      {
        ...event,
        targetRoles: ["Other"],
        targetGrades: ["Senior"],
        prerequisites: [{ skillId: "SQL", minLevel: 2 }],
      },
      profile,
    ).reasons,
    ["ROLE_MISMATCH", "GRADE_MISMATCH", "PREREQUISITE:SQL:2"],
  );
});
test("future means strictly after snapshot; full sessions support only explicit waitlist", () => {
  assert.ok(
    eligibility(
      {
        ...event,
        format: "online",
        sessions: [{ id: "1", date: "2026-10-01", capacity: 1, occupied: 0 }],
      },
      profile,
    ).reasons.includes("NO_FUTURE_SESSION"),
  );
  const full = {
    ...event,
    format: "online",
    sessions: [{ id: "1", date: "2026-10-02", capacity: 1, occupied: 1 }],
  };
  assert.ok(eligibility(full, profile).reasons.includes("NO_CAPACITY"));
  assert.equal(
    eligibility(full, profile, { allowWaitlist: true }).eligible,
    true,
  );
});
test("completed voluntary events cannot repeat except EV_036; active registration blocks duplicate", () => {
  const completed = {
    ...profile,
    history: [{ eventId: event.eventId, status: "completed" }],
  } as CareerProfile;
  assert.ok(
    eligibility(event, completed).reasons.includes("ALREADY_COMPLETED"),
  );
  assert.equal(
    eligibility({ ...event, eventId: "EV_036" }, {
      ...profile,
      history: [{ eventId: "EV_036", status: "completed" }],
    } as CareerProfile).eligible,
    true,
  );
  assert.equal(
    eligibility({ ...event, eventId: "EV_001", mandatory: true }, {
      ...profile,
      history: [{ eventId: "EV_001", status: "completed" }],
    } as CareerProfile).eligible,
    true,
  );
  assert.ok(
    eligibility(event, {
      ...profile,
      history: [{ eventId: event.eventId, status: "registered" }],
    } as CareerProfile).reasons.includes("ALREADY_ACTIVE"),
  );
});
