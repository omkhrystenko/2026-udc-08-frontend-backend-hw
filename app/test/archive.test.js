import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

let app;
beforeEach(() => {
  app = createApp(createDb(":memory:"));
});

const asOlya = (r) => r.set("x-user-id", "1");
const asTaras = (r) => r.set("x-user-id", "2");
const archive = (id, archived, as = asOlya) =>
  as(request(app).patch(`/api/notes/${id}`)).send({ archived });

describe("PATCH /api/notes/:id — archiving", () => {
  it("archives the caller's own note and moves it out of the default list", async () => {
    const res = await archive(1, true).expect(200);
    expect(res.body).toMatchObject({ id: 1, title: "Список покупок", archived: true });

    const active = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(active.body.map((n) => n.id)).toEqual([2]);

    const archived = await asOlya(request(app).get("/api/notes?archived=true")).expect(200);
    expect(archived.body.map((n) => n.id)).toEqual([1]);
  });

  it("restores an archived note", async () => {
    await archive(1, true).expect(200);
    const res = await archive(1, false).expect(200);
    expect(res.body.archived).toBe(false);

    const active = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(active.body.map((n) => n.id)).toEqual([1, 2]);
  });

  // A double click or a retried request repeats the same intent. With a
  // "toggle" endpoint the second call would silently undo the first.
  it("is idempotent: archiving twice leaves the note archived", async () => {
    await archive(1, true).expect(200);
    const res = await archive(1, true).expect(200);
    expect(res.body.archived).toBe(true);

    const archived = await asOlya(request(app).get("/api/notes?archived=true")).expect(200);
    expect(archived.body.map((n) => n.id)).toEqual([1]);
  });

  it("returns only client-facing fields, with a boolean flag", async () => {
    const res = await archive(1, true).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(["archived", "body", "created_at", "id", "title"]);
    expect(res.body).not.toHaveProperty("user_id");
  });

  it("404s for a note that does not exist", async () => {
    await archive(999, true).expect(404);
  });
});

describe("PATCH /api/notes/:id — authorization", () => {
  it("will not archive someone else's note", async () => {
    const res = await archive(3, true).expect(404);
    // Same answer as for a missing note: the caller learns nothing about id 3.
    expect(res.body).toEqual({ error: "not found" });

    const taras = await asTaras(request(app).get("/api/notes/3")).expect(200);
    expect(taras.body.archived).toBe(false);
  });

  it("will not restore someone else's archived note", async () => {
    await archive(3, true, asTaras).expect(200);
    await archive(3, false, asOlya).expect(404);

    const taras = await asTaras(request(app).get("/api/notes?archived=true")).expect(200);
    expect(taras.body.map((n) => n.id)).toEqual([3]);
  });

  it("requires an authenticated caller", async () => {
    await request(app).patch("/api/notes/1").send({ archived: true }).expect(401);
  });
});

describe("PATCH /api/notes/:id — server-side validation", () => {
  it.each([
    ["a string", { archived: "true" }],
    ["a number", { archived: 1 }],
    ["null", { archived: null }],
    ["a missing flag", {}],
  ])("rejects %s instead of a boolean", async (_, payload) => {
    const res = await asOlya(request(app).patch("/api/notes/1")).send(payload).expect(400);
    expect(res.body.error).toBe("archived must be a boolean");
  });

  it("rejects fields it does not handle rather than ignoring them", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1"))
      .send({ archived: true, user_id: 2, title: "підміна" })
      .expect(400);
    expect(res.body.error).toBe("unsupported fields: user_id, title");

    // Nothing was applied, not even the valid part.
    const note = await asOlya(request(app).get("/api/notes/1")).expect(200);
    expect(note.body).toMatchObject({ title: "Список покупок", archived: false });
  });

  it("rejects a JSON array body", async () => {
    await asOlya(request(app).patch("/api/notes/1")).send([{ archived: true }]).expect(400);
  });

  it.each(["abc", "0", "-1", "1.5", "1e0"])("rejects the malformed id %s", async (id) => {
    const res = await asOlya(request(app).patch(`/api/notes/${id}`))
      .send({ archived: true })
      .expect(400);
    expect(res.body.error).toBe("invalid note id");
  });

  it("answers malformed JSON with a JSON error, not an HTML stack trace", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1"))
      .set("content-type", "application/json")
      .send('{"archived": ')
      .expect(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "invalid JSON" });
    expect(res.text).not.toMatch(/node_modules|SyntaxError/);
  });
});

describe("GET /api/notes — archive filter", () => {
  it("rejects an unknown value of ?archived instead of silently showing active notes", async () => {
    for (const value of ["1", "yes", "banana", ""]) {
      const res = await asOlya(request(app).get(`/api/notes?archived=${value}`)).expect(400);
      expect(res.body.error).toBe("archived must be true or false");
    }
  });

  it("gives every note in the list a boolean archived flag and no owner id", async () => {
    const res = await asOlya(request(app).get("/api/notes")).expect(200);
    for (const note of res.body) {
      expect(note.archived).toBe(false);
      expect(note).not.toHaveProperty("user_id");
    }
  });

  it("keeps someone else's archive out of the caller's archive view", async () => {
    await archive(3, true, asTaras).expect(200);
    const olya = await asOlya(request(app).get("/api/notes?archived=true")).expect(200);
    expect(olya.body).toEqual([]);
  });
});

describe("POST /api/notes — ownership", () => {
  it("ignores an owner id smuggled into the body", async () => {
    const res = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Чия я?", user_id: 2 })
      .expect(201);
    expect(res.body).not.toHaveProperty("user_id");

    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body.map((n) => n.title)).not.toContain("Чия я?");
    const olya = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(olya.body.map((n) => n.title)).toContain("Чия я?");
  });

  it("creates new notes as not archived", async () => {
    const res = await asOlya(request(app).post("/api/notes")).send({ title: "Нова" }).expect(201);
    expect(res.body.archived).toBe(false);
  });
});

describe("createDb — migration", () => {
  it("adds the archived column to a database created before the feature", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "ws08-"));
    const file = join(dir, "old.db");
    let db;
    try {
      // A notes.db exactly as the seeded schema left it: no archived column.
      const old = new Database(file);
      old.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users VALUES (1, 'Оля');
        INSERT INTO notes (user_id, title) VALUES (1, 'стара нотатка');
      `);
      old.close();

      db = createDb(file);
      const migrated = createApp(db);
      const list = await asOlya(request(migrated).get("/api/notes")).expect(200);
      expect(list.body).toEqual([expect.objectContaining({ title: "стара нотатка", archived: false })]);

      await asOlya(request(migrated).patch(`/api/notes/${list.body[0].id}`))
        .send({ archived: true })
        .expect(200);
    } finally {
      // Windows will not delete a SQLite file that still has an open handle.
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
