// Budgets: the file, project and global scopes, today-only extensions, and usage against limits.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applicable, clearBudget, entriesOf, evaluate, extendBudget, fileNotice, isOver, limitKeys, loadBudgets, parseAmount, saveBudgets, setBudget,
} from "../src/budgets.mjs";
import { refresh } from "../src/index.mjs";
import { buildCells } from "../src/usage.mjs";
import { normPath } from "../src/util.mjs";
import { ALPHA, BETA, NOW, buildFixture, expected, near, readJson, sandbox } from "./helpers.mjs";

const TODAY = "2026-10-07";
const usd = (n) => ({ unit: "usd", amount: n });
const tok = (n) => ({ unit: "tokens", amount: n });
const fresh = () => ({ version: 1, global: null, projects: [], invalid: false, problems: [] });
const writeRaw = (box, raw) => {
  fs.mkdirSync(box.guard, { recursive: true });
  fs.writeFileSync(path.join(box.guard, "budgets.json"), typeof raw === "string" ? raw : JSON.stringify(raw));
};

test("a missing budgets file means no budgets; a broken one is flagged, not trusted", () => {
  const box = sandbox();
  try {
    assert.deepEqual(loadBudgets(box.cfg), fresh());
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), "{broken");
    const b = loadBudgets(box.cfg);
    assert.equal(b.invalid, true);
    assert.deepEqual(entriesOf(b), []);
    fs.writeFileSync(path.join(box.guard, "budgets.json"), "[1,2]");
    assert.equal(loadBudgets(box.cfg).invalid, true, "valid JSON of the wrong kind");
  } finally { box.cleanup(); }
});

test("budgets round-trip through the file, and junk inside it is dropped", () => {
  const box = sandbox();
  try {
    const b = fresh();
    setBudget(b, { daily: usd(15), weekly: usd(80), mode: "hard" });
    setBudget(b, { dir: ALPHA, daily: tok(3e6) });
    saveBudgets(box.cfg, b);
    assert.deepEqual(readJson(path.join(box.guard, "budgets.json")), {
      version: 1,
      global: { daily: usd(15), weekly: usd(80), mode: "hard" },
      projects: [{ dir: ALPHA, daily: tok(3e6), mode: "soft" }],
    });
    assert.deepEqual(loadBudgets(box.cfg), b);
    fs.writeFileSync(path.join(box.guard, "budgets.json"), JSON.stringify({
      global: { daily: { unit: "usd", amount: -5 }, weekly: { unit: "euros", amount: 5 }, mode: "extreme" },
      projects: [{ dir: "", daily: usd(1) }, { daily: usd(1) }, { dir: "/ok", daily: usd(2), mode: "hard", ext: { day: TODAY, usd: 3, tokens: "x" } }, "nonsense"],
    }));
    const loaded = loadBudgets(box.cfg);
    assert.deepEqual(entriesOf(loaded).map((e) => e.key), ["/ok"], "no valid limit: no budget");
    assert.deepEqual(loaded.projects[0].ext, { day: TODAY, usd: 3, tokens: 0 });
    assert.equal(loaded.projects[0].mode, "hard");
    assert.deepEqual(loaded.problems.map((p) => p.at), ["global.daily.amount", "global.weekly.unit", "global.mode", "projects[0].dir", "projects[1].dir", "projects[3]"], "each dropped setting is named");
  } finally { box.cleanup(); }
});

test("a hand edit is read as meant where that is beyond doubt: an amount as text, a mode or unit in capitals", () => {
  const box = sandbox();
  try {
    writeRaw(box, {
      version: 1,
      global: { daily: { unit: "usd", amount: "6" }, weekly: { unit: "USD", amount: " 40.50 " }, mode: "Hard" },
      projects: [{ dir: ALPHA, daily: { unit: " Tokens ", amount: "3000000" }, mode: " SOFT " }],
      models: [{ model: "opus", daily: { unit: "usd", amount: ".5" }, mode: "HARD" }],
    });
    const b = loadBudgets(box.cfg);
    assert.deepEqual(b.problems, [], "nothing to report");
    assert.deepEqual(b.global, { daily: usd(6), weekly: usd(40.5), mode: "hard" });
    assert.deepEqual(b.projects[0], { dir: ALPHA, daily: tok(3e6), mode: "soft" });
    assert.deepEqual(b.models[0], { model: "opus", dir: null, daily: usd(0.5), mode: "hard" });
    saveBudgets(box.cfg, b);
    const saved = readJson(path.join(box.guard, "budgets.json"));
    assert.deepEqual(saved.global, { daily: usd(6), weekly: usd(40.5), mode: "hard" }, "saved back as numbers and lower case");
    assert.equal("problems" in saved || "invalid" in saved, false);
  } finally { box.cleanup(); }
});

test("every setting that cannot be read is named with where it is and what happens; notes for a person are left alone", () => {
  const box = sandbox();
  try {
    writeRaw(box, {
      version: 1,
      _comment: "my budgets",
      "//": "a note",
      globl: {},
      global: { daily: { unit: "usd", amount: "six" }, dialy: { unit: "usd", amount: 5 }, mode: "block", $note: "x" },
      projects: [
        { dir: ALPHA, daily: "15usd" },
        { dir: BETA, weekly: { amount: 5 }, daily: { unit: "usd" } },
        { dir: "/c", daily: { unit: "eur", amount: 5 }, weekly: { unit: "usd", amount: 0 } },
      ],
      models: [{ daily: usd(1) }, "opus"],
    });
    const b = loadBudgets(box.cfg);
    assert.deepEqual(b.problems.map((p) => p.at), [
      "global.daily.amount", "global.mode", "global.dialy",
      "projects[0].daily", "projects[1].daily.amount", "projects[1].weekly.unit", "projects[2].daily.unit", "projects[2].weekly.amount",
      "models[0].model", "models[1]",
      "globl",
    ]);
    const text = (at) => b.problems.find((p) => p.at === at).text;
    assert.equal(text("global.daily.amount"), 'global.daily.amount is "six", which is not a number above 0, so that limit is not in force.');
    assert.equal(text("global.mode"), 'global.mode is "block", which is neither "hard" nor "soft", so the budget is soft.');
    assert.equal(text("global.dialy"), 'global has "dialy", a setting cost guard does not read, so it does nothing.');
    assert.equal(text("projects[0].daily"), 'projects[0].daily is "15usd", not an object such as {"unit": "usd", "amount": 15}, so that limit is not in force.');
    assert.equal(text("projects[1].weekly.unit"), 'projects[1].weekly has no "unit" ("usd" or "tokens"), so that limit is not in force.');
    assert.equal(text("projects[2].daily.unit"), 'projects[2].daily.unit is "eur", which is neither "usd" nor "tokens", so that limit is not in force.');
    assert.equal(text("models[0].model"), 'models[0] has no "model" (the model family or name it covers), so it is not in force.');
    assert.equal(text("models[1]"), 'models[1] is "opus", not an object, so it is not in force.');
    assert.equal(text("globl"), 'the file has "globl", a setting cost guard does not read, so it does nothing.');
    assert.deepEqual(entriesOf(b), [], "as before, nothing unreadable is in force");
    writeRaw(box, { projects: { dir: ALPHA }, models: 3, global: [] });
    assert.deepEqual(loadBudgets(box.cfg).problems.map((p) => p.text), [
      "global is [], not an object, so no budget for all projects is in force.",
      'projects is {"dir":"D:\\\\work\\\\alpha"}, not a list, so no project budget is in force.',
      "models is 3, not a list, so no model budget is in force.",
    ]);
  } finally { box.cleanup(); }
});

test("fileNotice: nothing for a clean or missing file, the JSON error, one setting in full, several by name", () => {
  const box = sandbox();
  try {
    const file = path.join(box.guard, "budgets.json");
    assert.equal(fileNotice(loadBudgets(box.cfg), file), null, "missing");
    writeRaw(box, { version: 1, global: { daily: usd(5), mode: "hard" } });
    assert.equal(fileNotice(loadBudgets(box.cfg), file), null, "clean");
    writeRaw(box, "{oops");
    assert.equal(fileNotice(loadBudgets(box.cfg), file), `Cost guard: ${file} is not valid JSON, so no budget is in force. Fix it, or delete it to start again.`);
    writeRaw(box, { global: { daily: usd(5), mode: "Hrad" } });
    assert.equal(fileNotice(loadBudgets(box.cfg), file), 'Cost guard: in budgets.json, global.mode is "Hrad", which is neither "hard" nor "soft", so the budget is soft.');
    writeRaw(box, { a: 1, b: 2, c: 3, d: 4, e: 5 });
    assert.equal(fileNotice(loadBudgets(box.cfg), file), "Cost guard: budgets.json has 5 settings it cannot read as written (a, b, c and 2 more). Run  claude-cost-guard budget show  to see each one.");
  } finally { box.cleanup(); }
});

test("set: all projects or one project, daily and/or weekly; the mode is kept unless changed", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15) });
  assert.deepEqual(b.global, { daily: usd(15), mode: "soft" });
  setBudget(b, { weekly: usd(80), mode: "hard" });
  assert.deepEqual(b.global, { daily: usd(15), weekly: usd(80), mode: "hard" });
  setBudget(b, { daily: usd(20) });
  assert.deepEqual(b.global, { daily: usd(20), weekly: usd(80), mode: "hard" }, "changing a limit does not reset the mode");
  setBudget(b, { dir: "D:\\work\\alpha", daily: usd(5) });
  setBudget(b, { dir: "d:/work/ALPHA/", weekly: usd(30) });
  assert.equal(b.projects.length, 1, "the same folder in another spelling is the same budget");
  assert.deepEqual(b.projects[0], { dir: "D:\\work\\alpha", daily: usd(5), weekly: usd(30), mode: "soft" });
  setBudget(b, { dir: BETA, daily: tok(1e6) });
  assert.equal(b.projects.length, 2);
});

test("which budgets apply where: all-projects everywhere, a project budget inside its folder", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15) });
  setBudget(b, { dir: ALPHA, daily: usd(5) });
  setBudget(b, { dir: BETA, daily: usd(7) });
  const labels = (cwd) => applicable(b, cwd).map((e) => e.label);
  assert.deepEqual(labels("D:\\work\\alpha"), ["all projects", "alpha"]);
  assert.deepEqual(labels("D:\\work\\alpha\\src\\deep"), ["all projects", "alpha"], "a subfolder belongs to the project");
  assert.deepEqual(labels("d:/work/ALPHA"), ["all projects", "alpha"], "any slash style, any case on Windows paths");
  assert.deepEqual(labels("D:\\work\\alphabet"), ["all projects"], "a folder that only starts with the same letters is another project");
  assert.deepEqual(labels("/home/dev/beta/x"), ["all projects", "beta"]);
  assert.deepEqual(labels(""), ["all projects"], "no folder known: only the all-projects budget");
  assert.deepEqual(labels("/elsewhere"), ["all projects"]);
  const nested = fresh();
  setBudget(nested, { dir: "D:\\work", daily: usd(50) });
  setBudget(nested, { dir: ALPHA, daily: usd(5) });
  assert.deepEqual(applicable(nested, "D:\\work\\alpha").map((e) => e.label), ["work", "alpha"], "nested folders: both count");
});

test("clear: everything, one project, the all-projects budget, or only one period", () => {
  const make = () => {
    const b = fresh();
    setBudget(b, { daily: usd(15), weekly: usd(80) });
    setBudget(b, { dir: ALPHA, daily: usd(5), weekly: usd(30) });
    setBudget(b, { dir: BETA, daily: usd(7) });
    return b;
  };
  let b = make();
  assert.equal(clearBudget(b, {}), 5, "everything");
  assert.deepEqual([b.global, b.projects], [null, []]);
  b = make();
  assert.equal(clearBudget(b, { dir: "d:/work/alpha" }), 2);
  assert.deepEqual(b.projects.map((p) => p.dir), [BETA]);
  assert.ok(b.global);
  b = make();
  assert.equal(clearBudget(b, { all: true }), 2);
  assert.equal(b.global, null);
  assert.equal(b.projects.length, 2, "--all is the all-projects budget, not everything");
  b = make();
  assert.equal(clearBudget(b, { weekly: true }), 2, "only weekly limits, wherever they are");
  assert.deepEqual([b.global.daily, b.global.weekly], [usd(15), undefined]);
  assert.equal(b.projects.length, 2);
  b = make();
  assert.equal(clearBudget(b, { dir: BETA, weekly: true }), 0, "nothing weekly there");
  assert.equal(clearBudget(fresh(), {}), 0);
  assert.deepEqual(limitKeys(entriesOf(make())), ["all|daily", "all|weekly", "d:/work/alpha|daily", "d:/work/alpha|weekly", "/home/dev/beta|daily"]);
});

test("extend: raises the limit for one day, per unit", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15), weekly: usd(80) });
  setBudget(b, { dir: ALPHA, daily: tok(3e6) });
  const keys = extendBudget(b, usd(5), {}, TODAY);
  assert.deepEqual(keys, ["all"], "only budgets counted in dollars");
  const e = entriesOf(b).find((x) => x.key === "all");
  assert.equal(JSON.stringify(e.ext), JSON.stringify({ day: TODAY, usd: 5, tokens: 0 }));
  extendBudget(b, usd(2), {}, TODAY);
  assert.equal(b.global.ext.usd, 7, "extensions add up");
  assert.deepEqual(extendBudget(b, tok(1e6), {}, TODAY), ["d:/work/alpha"]);
  assert.deepEqual(extendBudget(b, usd(1), { dir: ALPHA }, TODAY), [], "that project has no dollar budget");
  assert.deepEqual(extendBudget(b, usd(1), { all: true }, TODAY), ["all"]);
  // another day starts a fresh extension
  extendBudget(b, usd(4), {}, "2026-10-08");
  assert.deepEqual(b.global.ext, { day: "2026-10-08", usd: 4, tokens: 0 });
});

test("an extension counts today and not tomorrow", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15), weekly: usd(80) });
  extendBudget(b, usd(5), {}, TODAY);
  const [e] = entriesOf(b);
  const slots = (day) => evaluate([], [e], day);
  assert.deepEqual(slots(TODAY).map((s) => [s.period, s.base, s.extra, s.limit]), [["daily", 15, 5, 20], ["weekly", 80, 5, 85]]);
  assert.deepEqual(slots("2026-10-08").map((s) => [s.period, s.base, s.extra, s.limit]), [["daily", 15, 0, 15], ["weekly", 80, 0, 80]]);
});

test("usage against limits: global and project budgets, daily and weekly, dollars and tokens", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const { idx } = refresh(box.cfg, { now: NOW, full: true });
    const cells = buildCells(idx, { fromDay: "2026-10-05", toDay: TODAY });
    const b = fresh();
    setBudget(b, { daily: usd(19.04), weekly: tok(2792000) });
    setBudget(b, { dir: ALPHA, daily: usd(10), weekly: usd(5) });
    setBudget(b, { dir: BETA, daily: tok(3.5e6) });
    const slots = evaluate(cells, entriesOf(b), TODAY);
    const by = Object.fromEntries(slots.map((s) => [s.key, s]));
    assert.ok(near(by["all|daily"].used, expected.today.cost), "all projects, today, dollars");
    assert.ok(near(by["all|daily"].pct, 50), `${by["all|daily"].pct}`);
    assert.equal(by["all|weekly"].used, expected.week.fresh, "all projects, this week, tokens");
    assert.equal(by["all|weekly"].pct, 100);
    assert.ok(near(by["d:/work/alpha|daily"].used, 6.02), "alpha today: 3.40 + 2.40 + 0.22");
    assert.ok(near(by["d:/work/alpha|weekly"].used, 6.87), "alpha this week adds Tuesday's 0.70 and Monday's 0.15");
    assert.equal(by["/home/dev/beta|daily"].used, 1600000, "beta today in tokens");
    assert.ok(near(by["/home/dev/beta|daily"].pct, (1600000 / 3.5e6) * 100));
    assert.equal(by["d:/work/alpha|weekly"].isGlobal, false);
    assert.equal(by["all|daily"].isGlobal, true);
    assert.equal(isOver(by["d:/work/alpha|weekly"]), true, "$6.87 of $5");
    assert.equal(isOver(by["all|daily"]), false);
    assert.equal(isOver(by["all|weekly"]), true, "exactly 100% counts as used");
    assert.equal(slots.length, 5);
  } finally { box.cleanup(); }
});

test("amounts parse the same whether they come from the command line or the file", () => {
  assert.deepEqual(parseAmount("15usd"), usd(15));
  assert.deepEqual(parseAmount("3M"), tok(3e6));
});

test("set: model budgets with or without a project, daily and/or weekly", () => {
  const b = fresh();
  setBudget(b, { model: "opus", daily: usd(10) });
  assert.equal(b.models.length, 1);
  assert.deepEqual(b.models[0], { model: "opus", dir: null, daily: usd(10), mode: "soft" });
  setBudget(b, { model: "OPUS", weekly: usd(50), mode: "hard" });
  assert.equal(b.models.length, 1, "case-insensitive matching updates existing entry");
  assert.deepEqual(b.models[0], { model: "opus", dir: null, daily: usd(10), weekly: usd(50), mode: "hard" });
  setBudget(b, { dir: ALPHA, model: "sonnet", daily: tok(2e6) });
  assert.equal(b.models.length, 2);
  assert.deepEqual(b.models[1], { dir: ALPHA, model: "sonnet", daily: tok(2e6), mode: "soft" });
});

test("budgets round-trip with model budgets through the file", () => {
  const box = sandbox();
  try {
    const b = fresh();
    setBudget(b, { model: "opus", daily: usd(10) });
    setBudget(b, { dir: ALPHA, model: "sonnet", daily: tok(2e6) });
    saveBudgets(box.cfg, b);
    const loaded = loadBudgets(box.cfg);
    assert.deepEqual(loaded.models, [
      { model: "opus", dir: null, daily: usd(10), mode: "soft" },
      { dir: ALPHA, model: "sonnet", daily: tok(2e6), mode: "soft" },
    ]);
    const entries = entriesOf(loaded);
    assert.deepEqual(entries.map((e) => e.label), ["opus", "alpha (sonnet)"]);
    assert.deepEqual(entries.map((e) => e.key), ["model:opus", `${normPath(ALPHA)}|model:sonnet`]);
  } finally { box.cleanup(); }
});

test("clear: model budgets by model name, with or without project", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15) });
  setBudget(b, { model: "opus", daily: usd(10), weekly: usd(50) });
  setBudget(b, { dir: ALPHA, model: "sonnet", daily: usd(5) });
  assert.equal(clearBudget(b, { model: "opus", weekly: true }), 1, "clear weekly opus limit");
  assert.deepEqual(b.models[0].weekly, undefined);
  assert.deepEqual(b.models[0].daily, usd(10));
  assert.equal(clearBudget(b, { model: "opus" }), 1, "clear remaining daily opus budget");
  assert.equal(b.models.length, 1);
  assert.equal(clearBudget(b, { dir: ALPHA, model: "sonnet" }), 1);
  assert.equal(b.models.length, 0);
});

test("extend: raises the limit for a model budget", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15) });
  setBudget(b, { model: "opus", daily: usd(10) });
  const keys = extendBudget(b, usd(3), { model: "opus" }, TODAY);
  assert.deepEqual(keys, ["model:opus"]);
  const e = entriesOf(b).find((x) => x.key === "model:opus");
  assert.deepEqual(e.ext, { day: TODAY, usd: 3, tokens: 0 });
});

test("usage against limits: model budgets filter cells by model", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const { idx } = refresh(box.cfg, { now: NOW, full: true });
    const cells = buildCells(idx, { fromDay: "2026-10-05", toDay: TODAY });
    const b = fresh();
    setBudget(b, { model: "opus", daily: usd(3.40), weekly: usd(4.25) });
    setBudget(b, { model: "sonnet", daily: usd(5) });
    const slots = evaluate(cells, entriesOf(b), TODAY);
    const by = Object.fromEntries(slots.map((s) => [s.key, s]));
    assert.ok(near(by["model:opus|daily"].used, 3.40), "opus today is $3.40");
    assert.equal(by["model:opus|daily"].pct, 100);
    assert.ok(near(by["model:opus|weekly"].used, 4.25), "opus this week is $4.25");
    assert.equal(by["model:opus|weekly"].pct, 100);
    assert.ok(near(by["model:sonnet|daily"].used, 2.62), "sonnet today is $2.40 + $0.22 = $2.62");
    assert.equal(by["model:opus|daily"].isGlobal, false);
    assert.equal(by["model:opus|daily"].isModel, true);
    assert.equal(by["model:opus|daily"].model, "opus");
  } finally { box.cleanup(); }
});
