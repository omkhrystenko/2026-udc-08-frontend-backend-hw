// Minimal UI. No framework and no build step on purpose: the point of this
// homework is the seam between UI, API, database and authorization, not the
// view layer. Keep it that way — do not introduce a bundler.

const userSelect = document.querySelector("#user");
const list = document.querySelector("#notes");
const empty = document.querySelector("#empty");
const form = document.querySelector("#new-note");
const viewSwitch = document.querySelector("#view");
const heading = document.querySelector("#list-heading");
const status = document.querySelector("#status");

const VIEWS = {
  active: { heading: "Активні нотатки", empty: "Нотаток поки немає." },
  archived: {
    heading: "Архів",
    empty: "В архіві порожньо. Заархівовані нотатки з’являться тут.",
  },
};

function currentView() {
  return viewSwitch.querySelector("input:checked").value;
}

function headers() {
  return { "content-type": "application/json", "x-user-id": userSelect.value };
}

function announce(message) {
  // Clearing first makes a repeated message ("…архівовано" twice) re-announce.
  status.textContent = "";
  requestAnimationFrame(() => {
    status.textContent = message;
  });
}

/**
 * The list is re-rendered after every change, which would drop keyboard focus
 * onto <body>. Put it back on the same kind of control at the same position —
 * i.e. on the note that moved up into the removed one's place — or on the
 * empty-state message when nothing is left.
 */
function restoreFocus(role, index) {
  const buttons = list.querySelectorAll(`button[data-role="${role}"]`);
  if (buttons.length > 0) {
    buttons[Math.min(index, buttons.length - 1)].focus();
  } else {
    empty.focus();
  }
}

function noteItem(note, index) {
  const li = document.createElement("li");

  const grow = document.createElement("div");
  grow.className = "grow";
  const title = document.createElement("strong");
  title.textContent = note.title;
  const body = document.createElement("span");
  body.textContent = note.body;
  const when = document.createElement("small");
  when.textContent = note.created_at;
  grow.append(title, body, document.createElement("br"), when);

  // Visible text stays short; the accessible name starts with it (WCAG 2.5.3,
  // "label in name") and adds which note, so a screen reader list of buttons is
  // not three identical "Архівувати".
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.role = "archive";
  const verb = note.archived ? "Повернути з архіву" : "Архівувати";
  toggle.textContent = verb;
  toggle.setAttribute("aria-label", `${verb}: ${note.title}`);
  toggle.addEventListener("click", () =>
    changeNote(toggle, index, "archive", () =>
      fetch(`/api/notes/${note.id}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ archived: !note.archived }),
      }),
      note.archived
        ? `Нотатку «${note.title}» повернуто з архіву.`
        : `Нотатку «${note.title}» архівовано.`,
    ),
  );

  const del = document.createElement("button");
  del.type = "button";
  del.dataset.role = "delete";
  del.textContent = "Видалити";
  del.setAttribute("aria-label", `Видалити: ${note.title}`);
  del.addEventListener("click", () =>
    changeNote(
      del,
      index,
      "delete",
      () => fetch(`/api/notes/${note.id}`, { method: "DELETE", headers: headers() }),
      `Нотатку «${note.title}» видалено.`,
    ),
  );

  li.append(grow, toggle, del);
  return li;
}

/**
 * One path for every per-note action. The button is disabled for the duration
 * of the request, so a double click sends one request; the server side is
 * idempotent anyway, so even a retry could not undo the action.
 */
async function changeNote(button, index, role, send, doneMessage) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const res = await send();
    if (!res.ok) {
      announce(`Не вдалося: ${await errorText(res)}`);
      button.disabled = false;
      button.focus();
      return;
    }
  } catch {
    announce("Не вдалося зв’язатися з сервером.");
    button.disabled = false;
    button.focus();
    return;
  }

  // The action itself succeeded. What we say next depends on the reload:
  const outcome = await load();
  if (outcome === "ok") {
    announce(doneMessage);
    restoreFocus(role, index);
  } else if (outcome === "superseded") {
    // The user already switched view or user; a newer load owns the list and
    // focus. Report the action, but do not pull focus back.
    announce(doneMessage);
  } else {
    // load() has already announced its error; the list on screen is stale, so
    // give the user their button back rather than claiming success.
    button.disabled = false;
    button.focus();
  }
}

async function errorText(res) {
  try {
    return (await res.json()).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// Every load() gets a number; only the newest one may touch the DOM. Without
// this, switching views quickly lets a slow earlier response land last and
// show active notes under the "Архів" heading, or the other way round.
let latestLoad = 0;

/** @returns {Promise<"ok" | "failed" | "superseded">} */
async function load() {
  const ticket = ++latestLoad;
  const view = currentView();
  const user = userSelect.value;

  let notes;
  try {
    const res = await fetch(`/api/notes?archived=${view === "archived"}`, { headers: headers() });
    if (ticket !== latestLoad) return "superseded";
    if (!res.ok) {
      announce(`Не вдалося завантажити нотатки: ${await errorText(res)}`);
      return "failed";
    }
    notes = await res.json();
  } catch {
    if (ticket !== latestLoad) return "superseded";
    announce("Не вдалося завантажити нотатки: немає зв’язку з сервером.");
    return "failed";
  }
  if (ticket !== latestLoad || view !== currentView() || user !== userSelect.value) {
    return "superseded";
  }

  heading.textContent = VIEWS[view].heading;
  form.hidden = view === "archived";
  list.replaceChildren(...notes.map(noteItem));
  empty.textContent = VIEWS[view].empty;
  empty.hidden = notes.length > 0;
  return "ok";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.querySelector("#title");
  const body = document.querySelector("#body");
  try {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: title.value, body: body.value }),
    });
    if (!res.ok) {
      announce(`Не вдалося додати нотатку: ${await errorText(res)}`);
      return;
    }
  } catch {
    announce("Не вдалося додати нотатку: немає зв’язку з сервером.");
    return;
  }
  title.value = "";
  body.value = "";
  load();
});

viewSwitch.addEventListener("change", load);
userSelect.addEventListener("change", load);
load();
