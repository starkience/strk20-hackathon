import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/build-projects.mjs", import.meta.url), "utf8");
const helperStart = source.indexOf("async function ghAll");
const helperEnd = source.indexOf("/* Accepts the shapes", helperStart);
const helperSource = source.slice(helperStart, helperEnd);

function makeGhAll(responses) {
  const calls = [];
  const warnings = [];
  const gh = async (path) => {
    calls.push(path);
    return responses.shift();
  };
  const warn = (message) => warnings.push(message);
  const ghAll = Function("gh", "warn", `${helperSource}\nreturn ghAll;`)(gh, warn);
  return { ghAll, calls, warnings };
}

test("commit history continues past GitHub's first 100 results", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ sha: `first-${i}` }));
  const second = [{ sha: "second-0" }, { sha: "second-1" }];
  const { ghAll, calls } = makeGhAll([first, second]);

  const commits = await ghAll("/repos/example/project/commits?since=start");

  assert.equal(commits.length, 102);
  assert.deepEqual(calls, [
    "/repos/example/project/commits?since=start&per_page=100&page=1",
    "/repos/example/project/commits?since=start&per_page=100&page=2",
  ]);
});

test("an exact full page is followed until GitHub confirms the end", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ sha: `commit-${i}` }));
  const { ghAll, calls } = makeGhAll([first, []]);

  assert.equal((await ghAll("/repos/example/project/commits")).length, 100);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /commits\?per_page=100&page=1$/);
});

test("a failed later page never publishes a partial activity history", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ sha: `commit-${i}` }));
  const { ghAll, warnings } = makeGhAll([first, null]);

  assert.equal(await ghAll("/repos/example/project/commits?since=start"), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keeping the last complete activity snapshot/);
});

test("the indexer retains prior active days when history is unavailable", () => {
  assert.match(source, /const sprintHistoryComplete = Array\.isArray\(sprintCommits\)/);
  assert.match(source, /active_days: sprintHistoryComplete[\s\S]*prev\?\.active_days \|\| \[\]/);
});

test("the GitHub activity window freezes at the submission deadline", () => {
  assert.match(source, /const SPRINT_END = "2026-09-07T23:59:00Z"/);
  assert.match(source, /since=\$\{SPRINT_START\}&until=\$\{SPRINT_END\}/);
  assert.match(source, /d <= SPRINT_END\.slice\(0, 10\)/);
});

function cachedAssessment(prev, headSha) {
  const initialization = source.match(/let assessment =\s*([\s\S]*?);/);
  assert.ok(initialization, "assessment cache initialization must be present");
  return Function("prev", "headSha", `return (${initialization[1]});`)(prev, headSha);
}

test("project assessment cache reuses a facts_v2 verdict for the same repository head", () => {
  const assessment = { facts_v2: true, innovative: false, complex: false };
  assert.equal(cachedAssessment({ head_sha: "current", assessment }, "current"), assessment);
});

test("project assessment cache is invalidated when the repository head changes", () => {
  const assessment = { facts_v2: true, innovative: false, complex: false };
  assert.equal(cachedAssessment({ head_sha: "old", assessment }, "current"), null);
});

test("project assessment cache invalidates an older rubric even when the head is unchanged", () => {
  const assessment = { innovative: true, complex: true };
  assert.equal(cachedAssessment({ head_sha: "current", assessment }, "current"), null);
});

test("project assessment cache misses without a previous verdict", () => {
  assert.equal(cachedAssessment(undefined, "current"), null);
  assert.equal(cachedAssessment({ head_sha: "current" }, "current"), null);
  assert.equal(cachedAssessment({ head_sha: "current", assessment: null }, "current"), null);
});
