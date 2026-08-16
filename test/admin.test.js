import test from "node:test";
import assert from "node:assert/strict";
import { isAdministratorEmail, isAdministratorSession, normalizeAdminEmail } from "../src/auth/admin.js";

test("指定メールアドレスだけを管理者として判定する", () => {
  assert.equal(normalizeAdminEmail("  JUSTDOITTAKAMA1029@GMAIL.COM "), "justdoittakama1029@gmail.com");
  assert.equal(isAdministratorEmail("justdoittakama1029@gmail.com"), true);
  assert.equal(isAdministratorSession({ user: { email: "justdoittakama1029@gmail.com" } }), true);
  assert.equal(isAdministratorEmail("other@example.com"), false);
  assert.equal(isAdministratorSession(null), false);
});
