// Probe run INSIDE the agent's sandbox copy (app/test/zz-probe.test.js there),
// against the agent's code — not against this repo. Output: backend-probe-agent.txt.

import { it } from "vitest";
import request from "supertest";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

const as = (id) => (r) => r.set("x-user-id", String(id));
const olya = as(1);

it("B1 double request (double-click / retry)", async () => {
  const app = createApp(createDb(":memory:"));
  // user intends to archive note 1 once; the client fires twice
  await olya(request(app).patch("/api/notes/1/archive"));
  await olya(request(app).patch("/api/notes/1/archive"));
  const arch = await olya(request(app).get("/api/notes?archived=1"));
  const act = await olya(request(app).get("/api/notes"));
  console.log("B1 sequential x2 → archived list:", JSON.stringify(arch.body.map(n=>n.id)), "active list:", JSON.stringify(act.body.map(n=>n.id)));

  const app2 = createApp(createDb(":memory:"));
  await Promise.all([olya(request(app2).patch("/api/notes/1/archive")), olya(request(app2).patch("/api/notes/1/archive"))]);
  const arch2 = await olya(request(app2).get("/api/notes?archived=1"));
  console.log("B1 parallel x2  → archived list:", JSON.stringify(arch2.body.map(n=>n.id)));
});

it("B2 invalid ?archived values", async () => {
  const app = createApp(createDb(":memory:"));
  await olya(request(app).patch("/api/notes/1/archive"));
  for (const v of ["1", "true", "yes", "banana", ""]) {
    const r = await olya(request(app).get(`/api/notes?archived=${v}`));
    console.log(`B2 ?archived=${JSON.stringify(v)} → ${r.status}, ids=${JSON.stringify(r.body.map?.(n=>n.id))}`);
  }
});

it("B3 response shape", async () => {
  const app = createApp(createDb(":memory:"));
  const r = await olya(request(app).patch("/api/notes/1/archive"));
  console.log("B3 PATCH body:", JSON.stringify(r.body));
});

it("B5 PATCH body is ignored — client intent is not sent", async () => {
  const app = createApp(createDb(":memory:"));
  await olya(request(app).patch("/api/notes/1/archive"));           // now archived
  const r = await olya(request(app).patch("/api/notes/1/archive")).send({ archived: true }); // "archive it"
  console.log("B5 send {archived:true} on an archived note →", JSON.stringify(r.body));
});
