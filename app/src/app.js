import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Pretend session. A real app would verify a signed cookie or a JWT here;
 * that is deliberately out of scope — this workshop is about what happens
 * AFTER you know who the caller is.
 *
 * The caller identifies itself with the `x-user-id` header. Seeded users are
 * 1 (Оля) and 2 (Тарас).
 */
function currentUser(req, res, next) {
  const id = Number(req.header("x-user-id"));
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(401).json({ error: "not authenticated" });
  }
  req.userId = id;
  next();
}

/** Columns a client may see. `user_id` is deliberately absent. */
const NOTE_COLUMNS = "id, title, body, archived, created_at";

/** SQLite stores the flag as 0/1; the API speaks booleans. */
function toNote(row) {
  return { ...row, archived: row.archived === 1 };
}

/** A path id is a positive integer written plainly — not "1.0", " 1" or "1e0". */
function parseId(raw) {
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

export function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.static(resolve(here, "../public")));

  app.use("/api", currentUser);

  // List the caller's own notes: active ones by default, the archive with
  // ?archived=true. Any other value is a client error, not a silent default.
  app.get("/api/notes", (req, res) => {
    const { archived = "false" } = req.query;
    if (archived !== "true" && archived !== "false") {
      return res.status(400).json({ error: "archived must be true or false" });
    }
    const rows = db
      .prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE user_id = ? AND archived = ? ORDER BY id`)
      .all(req.userId, archived === "true" ? 1 : 0);
    res.json(rows.map(toNote));
  });

  // Read one of the caller's own notes. The owner condition lives in the query
  // itself: someone else's note is indistinguishable from a missing one (404),
  // so the endpoint does not even confirm that the id exists.
  app.get("/api/notes/:id", (req, res) => {
    const note = db
      .prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND user_id = ?`)
      .get(Number(req.params.id), req.userId);
    if (!note) return res.status(404).json({ error: "not found" });
    res.json(toNote(note));
  });

  // Archive or restore one of the caller's own notes. The client states the
  // state it wants ({ "archived": true }) instead of asking for a toggle, so a
  // double click or a network retry cannot undo the user's intent.
  app.patch("/api/notes/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid note id" });

    const payload = req.body;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return res.status(400).json({ error: "body must be a JSON object" });
    }
    const unknown = Object.keys(payload).filter((key) => key !== "archived");
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unsupported fields: ${unknown.join(", ")}` });
    }
    if (typeof payload.archived !== "boolean") {
      return res.status(400).json({ error: "archived must be a boolean" });
    }

    // One statement, owner condition included: nothing is read before the
    // write, so there is no window between "check" and "update".
    const note = db
      .prepare(
        `UPDATE notes SET archived = ? WHERE id = ? AND user_id = ? RETURNING ${NOTE_COLUMNS}`,
      )
      .get(payload.archived ? 1 : 0, id, req.userId);
    if (!note) return res.status(404).json({ error: "not found" });
    res.json(toNote(note));
  });

  // Create a note for the caller.
  app.post("/api/notes", (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    if (!title) return res.status(400).json({ error: "title is required" });

    const info = db
      .prepare("INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)")
      .run(req.userId, title, body);
    const created = db
      .prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND user_id = ?`)
      .get(info.lastInsertRowid, req.userId);
    res.status(201).json(toNote(created));
  });

  // Delete one of the caller's own notes.
  app.delete("/api/notes/:id", (req, res) => {
    const info = db
      .prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
      .run(Number(req.params.id), req.userId);
    if (info.changes === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  // Errors raised outside the handlers — most often express.json() rejecting a
  // malformed body. Express's default handler answers with an HTML page that
  // includes the stack trace and absolute server paths; answer with JSON and
  // keep internals out of the response. Express recognises an error handler by
  // its four parameters, so `next` must stay in the signature even unused.
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid JSON" });
    }
    res.status(err.status ?? 500).json({ error: "internal error" });
  });

  return app;
}
