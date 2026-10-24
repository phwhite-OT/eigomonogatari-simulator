import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isAdministratorEmail, isAdministratorSession } from "../src/auth/admin.js";

const ADMIN_EMAIL = "justdoittakama1029@gmail.com";

test("character database administrator is restricted to the configured account", () => {
  assert.equal(isAdministratorEmail(ADMIN_EMAIL), true);
  assert.equal(isAdministratorEmail("JUSTDOITTAKAMA1029@GMAIL.COM"), true);
  assert.equal(isAdministratorEmail("other@example.com"), false);
  assert.equal(isAdministratorSession({ user: { email: ADMIN_EMAIL } }), true);
  assert.equal(isAdministratorSession({ user: { email: "other@example.com" } }), false);
  assert.equal(isAdministratorSession(null), false);
});

test("Supabase RLS independently enforces the same administrator email", () => {
  const sql = fs.readFileSync("supabase/migrations/20260817_character_catalog_overrides.sql", "utf8");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /for select[\s\S]*using \(true\)/i);
  assert.match(sql, /for insert[\s\S]*to authenticated[\s\S]*justdoittakama1029@gmail\.com/i);
  assert.match(sql, /for update[\s\S]*to authenticated[\s\S]*justdoittakama1029@gmail\.com/i);
  assert.match(sql, /revoke delete[\s\S]*anon, authenticated/i);
});
